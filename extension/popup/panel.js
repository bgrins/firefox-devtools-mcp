"use strict";

const statusEl = document.getElementById("status");
const endpointEl = document.getElementById("endpoint");
const toggleEl = document.getElementById("toggle");

function render(state) {
  const running = !!state?.running;
  statusEl.innerHTML = running
    ? `MCP server: <span class="on">running (port ${state.port})</span>`
    : `MCP server: <span class="off">stopped</span>`;
  endpointEl.textContent = running ? `http://127.0.0.1:${state.port}/mcp` : "";
  toggleEl.textContent = running ? "Stop" : "Start";
  toggleEl.disabled = false;
}

async function refresh() {
  try {
    render(await browser.runtime.sendMessage({ type: "status" }));
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

toggleEl.addEventListener("click", async () => {
  toggleEl.disabled = true;
  const running = toggleEl.textContent === "Stop";
  try {
    render(await browser.runtime.sendMessage({ type: running ? "stop" : "start" }));
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    toggleEl.disabled = false;
  }
});

refresh();
