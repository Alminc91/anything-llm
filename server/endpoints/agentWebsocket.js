const { Telemetry } = require("../models/telemetry");
const {
  WorkspaceAgentInvocation,
} = require("../models/workspaceAgentInvocation");
const { AgentHandler } = require("../utils/agents");
const {
  WEBSOCKET_BAIL_COMMANDS,
} = require("../utils/agents/aibitat/plugins/websocket");
const { safeJsonParse } = require("../utils/http");

// KIE-534: Meldung an den Client, wenn die Limitprüfung selbst fehlschlägt.
const MESSAGES_LIMIT_CHECK_FAILED =
  "The message limit of this workspace could not be verified. Closing agent session.";

/**
 * KIE-534: Prüft das Nachrichtenlimit des Workspaces für eine Agent-Sitzung – mit
 * derselben Funktion wie der normale Chat, nur ohne HTTP-Antwortobjekt.
 * Ist das Limit erreicht, erhält der Client die Limit-Meldung des normalen Chats
 * und die Sitzung wird beendet. Schlägt die Prüfung selbst fehl (Workspace nicht
 * ladbar, Datenbankfehler beim Zählen), endet die Sitzung mit einer Fehlermeldung.
 * Ein Fehler verlässt diese Funktion nie: Sie läuft auch im Interrupt-Listener
 * des Websocket-Plugins, wo niemand ihn abfangen würde.
 * @param {import("ws").WebSocket} socket
 * @param {AgentHandler} agentHandler
 * @returns {Promise<boolean>} true, wenn die Sitzung beendet wurde
 */
async function closeOnMessagesLimit(socket, agentHandler) {
  let content;
  try {
    const { checkWorkspaceMessagesLimit } = require("../utils/helpers");
    // Den Workspace je Prüfung frisch laden: agentHandler.invocation.workspace
    // ist der Stand vom Verbindungsaufbau – ein inzwischen gesenktes oder
    // erstmals gesetztes Limit (oder ein neuer Zyklus) bliebe sonst für die
    // ganze Sitzung unbemerkt. Das frische Objekt dient nur dieser Prüfung.
    const current = await WorkspaceAgentInvocation.getWithWorkspace({
      uuid: String(agentHandler.invocation.uuid),
    });
    if (!current?.workspace)
      throw new Error("Workspace of the agent invocation could not be loaded.");

    // throwOnError: Ein Datenbankfehler beim Zählen gilt hier nicht als
    // Verbrauch 0, sondern landet im catch-Zweig und beendet die Sitzung.
    const { limitReached, errorData } = await checkWorkspaceMessagesLimit(
      current.workspace,
      null,
      { returnData: true, throwOnError: true }
    );
    if (!limitReached) return false;

    agentHandler.log(`Workspace message limit reached. Closing session now.`);
    content = errorData.error;
  } catch (e) {
    console.error(e.message, e);
    content = MESSAGES_LIMIT_CHECK_FAILED;
  }

  try {
    socket.send(JSON.stringify({ type: "wssFailure", content }));
  } catch (e) {
    console.error(e.message, e);
  } finally {
    socket.close();
  }
  return true;
}

// Setup listener for incoming messages to relay to socket so it can be handled by agent plugin.
function relayToSocket(message) {
  if (this.handleFeedback) return this?.handleFeedback?.(message);
  this.checkBailCommand(message);
}

function agentWebsocket(app) {
  if (!app) return;

  app.ws("/agent-invocation/:uuid", async function (socket, request) {
    try {
      const agentHandler = await new AgentHandler({
        uuid: String(request.params.uuid),
      }).init();

      if (!agentHandler.invocation) {
        socket.close();
        return;
      }

      socket.on("message", relayToSocket);
      socket.on("close", () => {
        agentHandler.closeAlert();
        WorkspaceAgentInvocation.close(String(request.params.uuid));
        return;
      });

      socket.checkBailCommand = (data) => {
        const content = safeJsonParse(data)?.feedback;
        if (WEBSOCKET_BAIL_COMMANDS.includes(content)) {
          agentHandler.log(
            `User invoked bail command while processing. Closing session now.`
          );
          agentHandler.aibitat.abort();
          socket.close();
          return;
        }
      };

      // KIE-534: Das Websocket-Plugin ruft diese Prüfung vor jeder weiteren
      // Nutzernachricht auf. Der Prompt der Invocation ist die erste davon –
      // bei erreichtem Limit beginnt die Sitzung gar nicht erst.
      socket.checkMessagesLimit = () =>
        closeOnMessagesLimit(socket, agentHandler);
      if (await socket.checkMessagesLimit()) return;

      await Telemetry.sendTelemetry("agent_chat_started");
      await agentHandler.createAIbitat({ socket });
      await agentHandler.startAgentCluster();
    } catch (e) {
      console.error(e.message, e);
      socket?.send(JSON.stringify({ type: "wssFailure", content: e.message }));
      socket?.close();
    }
  });
}

module.exports = { agentWebsocket };
