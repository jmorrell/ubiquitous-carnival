const $ = (id) => document.getElementById(id);
const itemQuery = location.search;
const childCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src blob: data:; media-src blob:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
let context;
let frame;
let port;
let ready = false;
let pending;
let proposalNumber = 0;

function renderNotes() {
  $("annotations").replaceChildren(...context.annotations.map((note) => {
    const li = document.createElement("li");
    li.textContent = note.body + (context.annotationStatus?.[note.id] === "historical" ? " (earlier processing revision)" : "");
    li.dataset.target = note.target;
    return li;
  }));
}
function artifactFor(id) {
  return context.item.originals.find((a) => a.id === id)
    ?? (context.generation.publication.artifacts.includes(id) ? { id } : undefined);
}
function validRange(range) {
  return range === undefined || (range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.end > range.start);
}
async function read(id, range) {
  if (typeof id !== "string" || !artifactFor(id)) throw new Error("Artifact not granted");
  if (!validRange(range)) throw new Error("Invalid byte range");
  const response = await fetch("/api/artifacts/" + encodeURIComponent(id) + itemQuery, {
    headers: range ? { Range: "bytes=" + range.start + "-" + (range.end - 1) } : {},
  });
  if (!response.ok) throw new Error("Artifact unavailable");
  const bytes = await response.arrayBuffer();
  return { bytes, mediaType: response.headers.get("content-type") ?? "application/octet-stream" };
}
function validTarget(id) {
  return typeof id === "string" && context.generation.targets.some((t) => t.id === id && t.itemId === context.item.itemId);
}
function clearProposal() {
  pending = undefined;
  $("proposal").hidden = true;
}
async function dispatch(event) {
  const request = event.data;
  if (!request || typeof request.id !== "string" || request.id.length > 100) return;
  try {
    if (request.method === "read") {
      const { bytes, mediaType } = await read(request.artifact, request.range);
      port.postMessage({ id: request.id, ok: true, bytes, mediaType }, [bytes]);
    } else if (request.method === "proposeAnnotation") {
      if (!validTarget(request.target)) throw new Error("Target not granted");
      if (typeof request.body !== "string" || !request.body.trim() || request.body.length > 4000) throw new Error("Invalid note");
      if (pending) throw new Error("A note is already awaiting confirmation");
      pending = { target: request.target, body: request.body, number: ++proposalNumber };
      $("proposal-body").textContent = pending.body;
      $("proposal").hidden = false;
      port.postMessage({ id: request.id, ok: true, value: "pending-host-confirmation" });
    } else {
      throw new Error("Unknown request");
    }
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: error.message });
  }
}
window.addEventListener("message", (event) => {
  if (ready || !frame || event.source !== frame.contentWindow || event.origin !== "null" || event.data?.type !== "magpie:ready") return;
  ready = true;
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = dispatch;
  frame.contentWindow.postMessage({ type: "magpie:init", context: { item: context.item, generation: context.generation } }, "*", [channel.port2]);
});
$("confirm").addEventListener("click", async (event) => {
  if (!event.isTrusted || !pending) return;
  const proposal = pending;
  $("confirm").disabled = true;
  try {
    const response = await fetch("/api/annotations" + itemQuery, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-host-action": "demo-confirmed" },
      body: JSON.stringify({ target: proposal.target, body: proposal.body }),
    });
    if (!response.ok) throw new Error("Note could not be saved");
    context = await (await fetch("/api/context" + itemQuery)).json();
    renderNotes();
    if (pending?.number === proposal.number) clearProposal();
    $("status").textContent = "Note saved.";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("confirm").disabled = false;
  }
});
$("cancel").addEventListener("click", clearProposal);
async function start() {
  context = await (await fetch("/api/context" + itemQuery)).json();
  $("title").textContent = context.generation.publication.title;
  const fallback = await read(context.generation.publication.presentation.fallback);
  $("fallback").textContent = new TextDecoder().decode(fallback.bytes);
  renderNotes();
  const component = context.generation.publication.presentation.component;
  if (!component) {
    $("viewer").textContent = "This item has a readable view.";
    return;
  }
  const source = await read(component);
  frame = document.createElement("iframe");
  frame.title = "Isolated item viewer";
  frame.setAttribute("sandbox", "allow-scripts");
  let loads = 0;
  frame.addEventListener("load", () => {
    if (++loads > 1) {
      port?.close();
      clearProposal();
      $("status").textContent = "Viewer closed after navigation.";
    }
  });
  frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="' + childCsp + '">' + new TextDecoder().decode(source.bytes);
  $("viewer").append(frame);
}
start().catch((error) => { $("status").textContent = error.message; });
