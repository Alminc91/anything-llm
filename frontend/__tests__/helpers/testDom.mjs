// Ein Dokument ohne Browser, gerade groß genug, damit React DOM eine Seite
// hineinzeichnen kann: Knoten, Attribute, Fokus. Der Test-Renderer hängt damit
// Komponenten ein (helpers/renderSettingsPage.mjs, mount), sodass Effekte
// laufen und sich der Zustand ändert – ohne neue Abhängigkeit.
//
// Grenzen: kein Layout (jedes Element misst 0 × 0), keine Stile, kein CSS,
// keine Ereignisse des Browsers. Eine Eingabe wird nachgestellt, indem der
// Handler aufgerufen wird, den React dem Element gegeben hat (handlersOf) –
// der Handler des Elements selbst, ohne Weiterreichen an die Eltern. Die
// Reihenfolge der Ereignisse, die ein Browser bei Mauszeiger, Klick, Tippen,
// Tasten und Fensterwechsel auslöst, steht in movePointer, click, tap,
// pressKey, leaveWindow und returnToWindow. Ob ein Browser sie so auslöst,
// zeigt nur der Browser-Test.

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const DOCUMENT = 9;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

class Node {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, before) {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode)
      if (current === this) return true;
    return false;
  }

  get textContent() {
    if (this.nodeType === TEXT) return this.nodeValue;
    if (this.nodeType === COMMENT) return "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    if (this.nodeType !== ELEMENT) {
      this.nodeValue = String(value);
      return;
    }
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value !== "" && value != null)
      this.appendChild(this.ownerDocument.createTextNode(value));
  }

  // React hängt seine Ereignisse an die Wurzel; hier löst nichts sie aus.
  addEventListener() {}

  removeEventListener() {}
}

class Element extends Node {
  constructor(tagName, namespaceURI, ownerDocument) {
    super(ELEMENT, tagName, ownerDocument);
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0 };
  }

  scrollIntoView() {}

  /** Wie im Browser: Das bisher fokussierte Element verliert den Fokus zuerst. */
  focus() {
    const document = this.ownerDocument;
    const previous = document.activeElement;
    if (previous === this) return;
    document.activeElement = this;
    if (previous) handlersOf(previous).onBlur?.(eventOn(previous));
    handlersOf(this).onFocus?.(eventOn(this));
  }

  blur() {
    const document = this.ownerDocument;
    if (document.activeElement !== this) return;
    document.activeElement = document.body;
    handlersOf(this).onBlur?.(eventOn(this));
  }
}

function eventOn(node, fields = {}) {
  return {
    target: node,
    currentTarget: node,
    preventDefault() {},
    stopPropagation() {},
    ...fields,
  };
}

/** @returns {object} - leeres Dokument mit <html><body> */
export function createDocument() {
  const document = new Node(DOCUMENT, "#document", null);
  document.createElement = (tagName) =>
    new Element(tagName.toUpperCase(), HTML_NAMESPACE, document);
  document.createElementNS = (namespaceURI, tagName) =>
    new Element(tagName, namespaceURI, document);
  document.createTextNode = (text) => {
    const node = new Node(TEXT, "#text", document);
    node.nodeValue = String(text);
    return node;
  };
  document.createComment = (text) => {
    const node = new Node(COMMENT, "#comment", document);
    node.nodeValue = String(text);
    return node;
  };
  document.documentElement = document.appendChild(
    document.createElement("html")
  );
  document.body = document.documentElement.appendChild(
    document.createElement("body")
  );
  document.activeElement = document.body;
  // Hat das Fenster den Fokus? (leaveWindow, returnToWindow)
  document.windowFocused = true;
  document.hasFocus = () => document.windowFocused;
  // Element unter dem Mauszeiger (movePointer)
  document.hoveredElement = null;
  return document;
}

/**
 * Die Eigenschaften, die React einem Element gegeben hat – darunter seine
 * Handler (onClick, onFocus …). React 17 bis 19 legen sie am Knoten unter
 * "__reactProps$<Zufall>" ab.
 * @param {object} node
 * @returns {Object<string, any>}
 */
export function handlersOf(node) {
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactProps$")
  );
  return key ? node[key] : {};
}

/**
 * Alle Elemente unter einem Knoten, in Dokumentreihenfolge.
 * @param {object} root
 * @param {(element: object) => boolean} [matches]
 * @returns {object[]}
 */
export function elements(root, matches = () => true, found = []) {
  for (const child of root.childNodes) {
    if (child.nodeType !== ELEMENT) continue;
    if (matches(child)) found.push(child);
    elements(child, matches, found);
  }
  return found;
}

/**
 * Der Mauszeiger wechselt auf ein Element: pointerleave am bisherigen, dann
 * pointerenter am neuen. Ohne Element verlässt er die Seite.
 * @param {object} document
 * @param {object|null} element
 */
export function movePointer(document, element) {
  const previous = document.hoveredElement;
  if (previous === element) {
    if (element) handlersOf(element).onPointerMove?.(eventOn(element));
    return;
  }
  document.hoveredElement = element;
  if (previous) handlersOf(previous).onPointerLeave?.(eventOn(previous));
  if (element) handlersOf(element).onPointerEnter?.(eventOn(element));
}

const isFocusable = (element) =>
  element.hasAttribute("tabindex") || element.tagName === "BUTTON";

/**
 * Mausklick: Der Zeiger steht auf dem Element; ein fokussierbares Element
 * (tabindex, Schaltfläche) bekommt beim Drücken der Taste den Fokus, nach dem
 * Loslassen folgt click. Ein Stift, der über dem Bildschirm schwebt, löst
 * dieselbe Folge aus (pointerType "pen").
 * @param {object} element
 * @param {"mouse"|"pen"} [pointerType]
 */
export function click(element, pointerType = "mouse") {
  const pointer = eventOn(element, { pointerType });
  movePointer(element.ownerDocument, element);
  handlersOf(element).onPointerDown?.(pointer);
  if (isFocusable(element)) element.focus();
  handlersOf(element).onPointerUp?.(pointer);
  handlersOf(element).onClick?.(eventOn(element));
}

/**
 * Tippen (Touch): Der Zeiger entsteht mit dem Finger und endet mit ihm –
 * pointerenter, pointerdown, pointerup, pointerleave. Fokus und click folgen
 * erst danach.
 * @param {object} element
 */
export function tap(element) {
  const document = element.ownerDocument;
  const pointer = eventOn(element, { pointerType: "touch" });
  movePointer(document, null);
  handlersOf(element).onPointerEnter?.(pointer);
  handlersOf(element).onPointerDown?.(pointer);
  handlersOf(element).onPointerUp?.(pointer);
  handlersOf(element).onPointerLeave?.(pointer);
  if (isFocusable(element)) element.focus();
  handlersOf(element).onClick?.(eventOn(element));
}

/**
 * Das Fenster verliert den Fokus (anderes Fenster, anderer Tab): Das aktive
 * Element bleibt es und bekommt blur, document.hasFocus() ist dabei schon
 * false – bei der Rückkehr bekommt es wieder focus.
 * @param {object} document
 */
export function leaveWindow(document) {
  const element = document.activeElement;
  document.windowFocused = false;
  handlersOf(element).onBlur?.(eventOn(element));
}

/** @param {object} document */
export function returnToWindow(document) {
  const element = document.activeElement;
  document.windowFocused = true;
  handlersOf(element).onFocus?.(eventOn(element));
}

/**
 * Taste auf dem fokussierten Element.
 * @param {object} document
 * @param {string} key - z. B. "ArrowRight", "Enter"
 */
export function pressKey(document, key) {
  const element = document.activeElement;
  handlersOf(element).onKeyDown?.(eventOn(element, { key }));
}
