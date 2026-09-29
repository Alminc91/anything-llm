# LLM-Optionen pro Anfrage (ab Image 7.7)

Anleitung für Test- und Analyse-Läufe über AnythingLLM, bei denen Thinking, Ausgabelänge,
Temperatur und weitere Modell-Parameter **pro Anfrage** gesetzt werden sollen. Alles hier gilt
nur für Container mit dem generischen OpenAI-Provider (bei uns: LiteLLM → vLLM, Modell `Chat1`
= Gemma-4-31B). Ohne die neuen Felder verhält sich die API exakt wie vor 7.7.

## 1. Zwei Wege, eine Whitelist

| Endpunkt | Wo stehen die Optionen | Validierung | Thinking-Ausgabe |
|---|---|---|---|
| `POST /api/v1/openai/chat/completions` | flach im Body, wie bei OpenAI | tolerant (siehe unten): Zahlen dürfen als String kommen, zu großes `max_tokens` wird geklemmt, `max_completion_tokens` als Alias | getrennt in `message.reasoning_content` bzw. `delta.reasoning_content` |
| `POST /api/v1/workspace/{slug}/chat` und `/stream-chat` sowie `/workspace/{slug}/thread/{threadSlug}/chat` und `/stream-chat` | im Objekt `llmOptions` | strikt: Typ und Bereich müssen stimmen, kein Klemmen | als führender Block `<think>…</think>` in `textResponse` |

Erlaubte Felder (alles optional):

| Feld | Wertebereich | Wirkung |
|---|---|---|
| `max_tokens` | Ganzzahl ≥ 1 bis zur Server-Obergrenze (`LLM_REQUEST_MAX_TOKENS_CEILING`, sonst 16384 bzw. das Kontextfenster des Modells, falls kleiner) | ersetzt den Container-Standard `GENERIC_OPEN_AI_MAX_TOKENS`. **Denk-Token zählen mit.** |
| `temperature` | 0 … 2 | Priorität: Anfrage → Workspace → 0,7 |
| `top_p` | 0 < x ≤ 1 | Nucleus Sampling |
| `chat_template_kwargs` | flaches Objekt, Standard-Whitelist nur `enable_thinking` (boolean) | wird unverändert an vLLM durchgereicht |
| `reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high` | Alias: alles außer `none` schaltet bei Gemma-4 Thinking ein. **Gemma-4 kennt keine Stufen**, `low` und `high` sind identisch. |

Ungültige Werte liefern **HTTP 400** mit sprechender Meldung, z. B.
`reasoning_effort must be one of: none, minimal, low, medium, high.` oder
`chat_template_kwargs contains the key "chat_template", which is not allowed. Allowed keys: enable_thinking.`

### Toleranzregeln am OpenAI-Endpunkt

Damit bestehende OpenAI-Clients ohne Anpassung weiterlaufen, ist nur dieser Endpunkt nachsichtig:

| Eingabe | Ergebnis |
|---|---|
| Zahl als String (`"4096"`, `"0.5"`) | wird umgewandelt |
| `null` bei einem Feld | wie nicht gesetzt |
| `max_tokens` ≤ 0 (z. B. `-1` = „unbegrenzt“ bei llama.cpp/LM Studio) oder nicht als Zahl lesbar | wie nicht gesetzt, es gilt `GENERIC_OPEN_AI_MAX_TOKENS` |
| `max_tokens` über der Server-Obergrenze (z. B. pauschal 32000) | **wird auf die Obergrenze geklemmt**, kein Fehler; der Server vermerkt das einmal im Log |
| `max_tokens` mit Nachkommastellen (`4096.5`) | HTTP 400 |
| `max_completion_tokens` (neuere OpenAI-SDKs) | Alias für `max_tokens`, gleiche Regeln; sind beide gesetzt, gewinnt `max_tokens` |
| `top_p` ≤ 0 | wie nicht gesetzt |
| `top_p` > 1 oder nicht als Zahl lesbar | HTTP 400 |

Fehler kommen an diesem Endpunkt in der **OpenAI-Fehlerform**, damit die OpenAI-SDKs sie als
`BadRequestError` mit `param` erkennen:

```json
{
  "error": {
    "message": "top_p must be a number greater than 0 and at most 1.",
    "type": "invalid_request_error",
    "param": "top_p",
    "code": null
  }
}
```

Die übrigen Fehlerantworten des Endpunkts (unbekannter Workspace, leere Nachricht, Kontingent)
bleiben wie bisher. An den Workspace-/Thread-Endpunkten gilt keine dieser Toleranzen:
`llmOptions` wird strikt geprüft (z. B. `max_tokens: 20000` oder `-1` → HTTP 400), der Fehler
kommt im bisherigen Format `{ "type": "abort", "error": "llmOptions.max_tokens must be …", … }`.
`max_completion_tokens` wird dort ignoriert.

## 2. Thinking pro Anfrage einschalten

Gemma-4 aktiviert Thinking über das Token `<|think|>` am Anfang des System-Prompts. Das setzt
das vLLM-Chat-Template selbst, sobald `enable_thinking: true` ankommt. **Nichts in den
Workspace-Prompt schreiben**, nur das Feld mitschicken.

### OpenAI-kompatibel (empfohlen für Agenten-Flows)

```bash
curl -s https://intern.ki.kufer.de/api/v1/openai/chat/completions \
  -H "Authorization: Bearer $ANYTHINGLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kufersql",
    "messages": [
      {"role": "system", "content": "Du bist ein Generator für Auswertungs-Spezifikationen."},
      {"role": "user", "content": "…Prompt…"}
    ],
    "temperature": 0.1,
    "max_tokens": 8192,
    "chat_template_kwargs": {"enable_thinking": true}
  }'
```

Antwort (gekürzt):

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "reasoning_content": "Der Nutzer möchte …",
      "content": "{\"spec_version\":1, …}"
    },
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 23412, "completion_tokens": 1874, "total_tokens": 25286,
            "duration": 41.2, "outputTps": 45.5}
}
```

`model` ist der Workspace-Slug. Die system-Nachricht der Anfrage ersetzt den Workspace-Prompt.
Ohne Thinking dieselbe Anfrage ohne `chat_template_kwargs` (oder `enable_thinking: false`).

Python (openai-SDK, Streaming):

```python
from openai import OpenAI
client = OpenAI(base_url="https://intern.ki.kufer.de/api/v1/openai", api_key=ANYTHINGLLM_API_KEY)

stream = client.chat.completions.create(
    model="kufersql",
    messages=[{"role": "user", "content": prompt}],
    temperature=0.1,
    max_tokens=8192,
    extra_body={"chat_template_kwargs": {"enable_thinking": True}},
    stream=True,
)
reasoning, answer = [], []
for chunk in stream:
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        reasoning.append(delta.reasoning_content)
    if delta.content:
        answer.append(delta.content)
```

### Workspace-Endpunkt (mit Verlauf und Kontingent)

```bash
curl -s https://intern.ki.kufer.de/api/v1/workspace/kufersql/chat \
  -H "Authorization: Bearer $ANYTHINGLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "…Prompt…",
    "mode": "chat",
    "sessionId": "lauf-2026-09-29-01",
    "llmOptions": {"max_tokens": 8192, "temperature": 0.1,
                   "chat_template_kwargs": {"enable_thinking": true}}
  }'
```

`textResponse` beginnt dann mit `<think>…</think>`, danach folgt die Antwort. Der gesamte Text
(inklusive Denkblock) wird im Chat-Verlauf gespeichert. Ohne `sessionId` hängt der Fork bewusst
keinen Verlauf an; mit `sessionId` gilt der Workspace-Verlauf (`openAiHistory`).

## 3. Was für saubere Tests wichtig ist

- **`max_tokens` groß genug wählen.** Bricht die Generierung während des Denkens ab
  (`finish_reason: "length"`), ist `content` leer und nur `reasoning_content` gefüllt.
  Für Spec-Generierung mit Thinking: 4096–8192.
- **Thinking an/aus sind zwei getrennte Cache-Linien.** Das `<|think|>`-Token steht ganz vorn,
  deshalb teilen sich Läufe mit und ohne Thinking keinen Prefix-Cache. Beide Linien können
  gleichzeitig warm sein. Empfehlung: Erstlauf ohne Thinking, Reparaturläufe mit Thinking; der
  erste Wechsel zahlt einmal das volle Prefill (≈ 8 s bei 23k Token, ≈ 20 s bei 56k).
- **Statischen Teil vorn und byte-identisch halten** (Wertebereiche, Schema), variable Teile
  (Spaltenliste, Frage) ans Ende. Nur so trifft der Prefix-Cache über Läufe hinweg.
- **Schritte direkt hintereinander schicken.** Der vLLM-Cache hält 20–30k-Token-Präfixe unter
  Tageslast nur wenige Sekunden bis Minuten.
- **Prompts über der Obergrenze** (70 % von `GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT`, auf intern
  ≈ 91k Token) werden vom Server aus der Mitte gekürzt. Prüfen: `usage.prompt_tokens` muss zur
  eigenen Zählung passen.
- Die Filter-Extraktion (KIE-480) und der Query-Rewriter laufen weiterhin ohne diese Optionen,
  damit Thinking oder ein kleines `max_tokens` sie nicht verfälschen.

## 4. Überwachung: was durchkommt und was nicht

| Kennzahl | über AnythingLLM | direkt über LiteLLM |
|---|---|---|
| `usage.prompt_tokens`, `completion_tokens`, `total_tokens` | ja (echte Werte von vLLM) | ja |
| `usage.duration`, `usage.outputTps` | ja (vom Fork gemessen) | nein |
| `usage.prompt_tokens_details.cached_tokens` | ja, unverändert durchgereicht (Stream und Nicht-Stream), sobald vLLM es liefert – also erst, wenn vLLM mit `--enable-prompt-tokens-details` läuft; vorher fehlt das Feld | ebenso |
| Kosten `x-litellm-response-cost`, `x-litellm-call-id`, `x-litellm-model-api-base` | **nein** (HTTP-Header der LiteLLM-Antwort, werden nicht durchgereicht) | ja, als Response-Header |
| Cache-Treffer global | `http://172.16.12.4:11430/metrics`: `vllm:prefix_cache_hits_total` / `vllm:prefix_cache_queries_total` (Zähler über alle Kunden, Differenz vor/nach der Anfrage bilden) | dito |

Für Kosten- und Cache-Telemetrie pro Anfrage bleibt der Direktweg über LiteLLM die vollständige
Quelle. Über AnythingLLM bekommt man dafür Verlauf, Kontingent-Zählung und die Trennung von
Reasoning und Antwort.

## 5. Einstellungen für Admins (Container-ENV)

| Variable | Bedeutung | intern |
|---|---|---|
| `GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT` | Kontextfenster, Prompts > 70 % davon werden gekürzt | 131072 |
| `GENERIC_OPEN_AI_MAX_TOKENS` | Standard-Ausgabelänge, wenn die Anfrage nichts setzt | 8192 |
| `LLM_REQUEST_MAX_TOKENS_CEILING` | Obergrenze für `max_tokens` pro Anfrage; ohne ENV gilt 16384 (bzw. das Kontextfenster, falls kleiner). Bewusst nicht das ganze Kontextfenster: die GPU ist flottenweit geteilt, sehr lange Generierungen verdrängen den Prefix-Cache aller Kunden. Nur für einzelne Container gezielt höher setzen. | nicht gesetzt (= 16384) |
| `LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST` | weitere erlaubte Schlüssel für `chat_template_kwargs`, kommagetrennt (z. B. für andere Modelle) | nicht gesetzt |

Die Flotte behält 45000/1024; intern hat die höheren Werte in `/var/docker/intern/intern.env`.
