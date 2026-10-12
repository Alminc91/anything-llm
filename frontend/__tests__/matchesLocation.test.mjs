import test from "node:test";
import assert from "node:assert/strict";
import matchesLocation from "../src/components/SettingsSidebar/MenuOption/matchesLocation.js";

const WIDGETS = {
  href: "/settings/chatbot/widgets",
  activePrefixes: ["/settings/embed-config/"],
};

test("matchesLocation: Adresse des Menüpunkts trifft", () => {
  assert.equal(matchesLocation(WIDGETS, "/settings/chatbot/widgets"), true);
  assert.equal(
    matchesLocation({ href: "/settings/users" }, "/settings/users"),
    true
  );
});

test("matchesLocation: Unterseite mit eigener Adresse trifft über das Präfix", () => {
  assert.equal(
    matchesLocation(WIDGETS, "/settings/embed-config/7/appearance"),
    true
  );
});

test("matchesLocation: fremde Adresse trifft nicht", () => {
  assert.equal(
    matchesLocation(WIDGETS, "/settings/chatbot/conversations"),
    false
  );
  // nur am Anfang der Adresse, nicht irgendwo darin
  assert.equal(
    matchesLocation(WIDGETS, "/other/settings/embed-config/7/appearance"),
    false
  );
  // ohne Präfixe zählt nur die exakte Adresse
  assert.equal(
    matchesLocation(
      { href: "/settings/chatbot/widgets" },
      "/settings/chatbot/widgets/1"
    ),
    false
  );
});

test("matchesLocation: leere oder ungültige Präfixe treffen nie", () => {
  for (const activePrefixes of [[""], [null, undefined], [], null, "/settings"])
    assert.equal(
      matchesLocation(
        { href: "/settings/chatbot/widgets", activePrefixes },
        "/settings/users"
      ),
      false,
      JSON.stringify(activePrefixes)
    );
});

test("matchesLocation: fehlende Angaben treffen nicht", () => {
  assert.equal(matchesLocation(undefined, "/settings/users"), false);
  assert.equal(matchesLocation({}, "/settings/users"), false);
  assert.equal(matchesLocation(WIDGETS), false);
});
