const statusEl = document.querySelector("#status");
const noticeEl = document.querySelector("#notice");
const messagesEl = document.querySelector("#messages");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const sendButton = form.querySelector("button");

function addMessage(role, content) {
  const item = document.createElement("div");
  item.className = `bubble ${role}`;
  item.textContent = content;
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return item;
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    statusEl.textContent = response.ok ? (data.apiConfigured ? "Système prêt" : "Clé API à configurer") : "Indisponible";
    statusEl.style.color = data.apiConfigured ? "#a9c7b2" : "#e6c778";
    noticeEl.textContent = data.apiConfigured
      ? "Father of Lights est prêt à recevoir ton message."
      : "Interface publiée. La clé API privée doit encore être configurée pour activer les réponses.";
  } catch {
    statusEl.textContent = "Hors ligne";
    noticeEl.textContent = "Impossible de joindre le serveur.";
  }
}

document.querySelector("#activate").addEventListener("click", () => {
  input.focus();
  noticeEl.textContent = "Le contact commence par un message.";
  document.querySelector(".chat-panel").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#genesis").addEventListener("click", () => {
  document.querySelector(".hero").classList.toggle("awakened");
  noticeEl.textContent = "Pixel Genesis sélectionné. Écris à Father of Lights pour commencer.";
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || sendButton.disabled) return;
  addMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  const waiting = addMessage("assistant", "Je réfléchis…");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    const data = await response.json();
    waiting.textContent = data.answer || data.error || "Le service est momentanément indisponible.";
  } catch {
    waiting.textContent = "Impossible de joindre le serveur. Vérifie la connexion et réessaie.";
  } finally {
    sendButton.disabled = false;
    input.focus();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});
checkHealth();
