const ticketPrice = 1.99;
const minimumPurchase = 5;
const quickOptions = [1, 48, 100, 200, 300, 500];

const API = {
  userFind: "/api/users/find",
  pixCharge: "/api/pix/charge",
  pixConfirm: "/api/pix/confirm",
  purchases: "/api/purchases",
  adminPurchases: "/api/admin/purchases",
  adminExport: "/api/admin/export",
  adminStats: "/api/admin/stats",
  adminConfig: "/api/admin/config",
  adminTicketStatus: "/api/admin/ticket-status"
};

const quickButtons = document.getElementById("quickButtons");
const qtyValue = document.getElementById("qtyValue");
const minPurchaseHint = document.getElementById("minPurchaseHint");
const participarBtn = document.getElementById("participarBtn");
const minusBtn = document.getElementById("minusBtn");
const plusBtn = document.getElementById("plusBtn");

const myTicketsBtn = document.getElementById("myTicketsBtn");

const checkoutPanel = document.getElementById("checkoutPanel");
const summaryBox = document.getElementById("summaryBox");
const backBtn = document.getElementById("backBtn");
const summaryQty = document.getElementById("summaryQty");
const summaryTotal = document.getElementById("summaryTotal");

const phoneInput = document.getElementById("phoneInput");
const phoneContinue = document.getElementById("phoneContinue");
const existingContinue = document.getElementById("existingContinue");
const registerContinue = document.getElementById("registerContinue");

const existingName = document.getElementById("existingName");
const existingPhone = document.getElementById("existingPhone");

const nameInput = document.getElementById("nameInput");
const cpfInput = document.getElementById("cpfInput");
const emailInput = document.getElementById("emailInput");
const phoneConfirmInput = document.getElementById("phoneConfirmInput");
const birthInput = document.getElementById("birthInput");

const pixCodeInput = document.getElementById("pixCodeInput");
const copyPixBtn = document.getElementById("copyPixBtn");
const qrImage = document.getElementById("qrImage");
const countdown = document.getElementById("countdown");
const verifyStatusBtn = document.getElementById("verifyStatusBtn");
const statusMessage = document.getElementById("statusMessage");

const purchaseName = document.getElementById("purchaseName");
const purchasePhone = document.getElementById("purchasePhone");
const purchaseDate = document.getElementById("purchaseDate");
const purchaseTotal = document.getElementById("purchaseTotal");

const successDetails = document.getElementById("successDetails");
const successTickets = document.getElementById("successTickets");
const successTicketCount = document.getElementById("successTicketCount");
const successMyTicketsBtn = document.getElementById("successMyTicketsBtn");

const rulesToggle = document.getElementById("rulesToggle");
const rulesContent = document.getElementById("rulesContent");
const rulesArrow = document.getElementById("rulesArrow");

const lookupOverlay = document.getElementById("lookupOverlay");
const closeLookupBtn = document.getElementById("closeLookupBtn");
const lookupTabs = Array.from(document.querySelectorAll(".tab"));
const lookupLabel = document.getElementById("lookupLabel");
const lookupInput = document.getElementById("lookupInput");
const lookupContinueBtn = document.getElementById("lookupContinueBtn");
const lookupMessage = document.getElementById("lookupMessage");
const lookupResult = document.getElementById("lookupResult");

let quantity = minimumPurchase;
let timerId;
let activeUser = null;
let activeCharge = null;
let activeLookupMethod = "phone";
let latestPaidPurchase = null;
let currentAdminCpf = "";
let currentAdminStats = null;
let adminPollingId = null;

function money(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value) {
  return onlyDigits(value);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function maskDate(value) {
  const digits = onlyDigits(value).slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
}

function maskCpf(value) {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function maskPhone(value) {
  const digits = onlyDigits(value).slice(0, 13);
  if (!digits) return "";
  const cc = digits.slice(0, 2);
  const ddd = digits.slice(2, 4);
  const rest = digits.slice(4);
  if (digits.length <= 2) return `+${cc}`;
  if (digits.length <= 4) return `+${cc} (${ddd}`;
  if (rest.length <= 5) return `+${cc} (${ddd}) ${rest}`;
  return `+${cc} (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5, 9)}`;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Erro de API.");
  }
  return data;
}

function setStatus(message, type = "") {
  statusMessage.textContent = message;
  statusMessage.className = "status-message";
  if (type) statusMessage.classList.add(type);
}

function setLookupMessage(message, type = "") {
  lookupMessage.textContent = message;
  lookupMessage.className = "status-message";
  if (type) lookupMessage.classList.add(type);
}

function setStep(stepId) {
  document.querySelectorAll(".step").forEach((el) => el.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
  summaryBox.style.display = stepId === "stepSuccess" ? "none" : "block";
}

function updateSummary() {
  const total = quantity * ticketPrice;
  qtyValue.textContent = String(quantity);
  participarBtn.textContent = `Participar R$ ${money(total)}`;
  summaryQty.textContent = String(quantity);
  summaryTotal.textContent = money(total);
  purchaseTotal.textContent = money(total);

  minPurchaseHint.textContent = quantity < minimumPurchase ? `Quantidade minima: ${minimumPurchase} numeros.` : "";
}

function openCheckout() {
  if (quantity < minimumPurchase) {
    minPurchaseHint.textContent = `Para continuar, selecione no minimo ${minimumPurchase} numeros.`;
    return;
  }

  checkoutPanel.classList.add("open");
  checkoutPanel.setAttribute("aria-hidden", "false");
  setStep("stepPhone");
  phoneInput.focus();
}

function closeCheckout() {
  checkoutPanel.classList.remove("open");
  checkoutPanel.setAttribute("aria-hidden", "true");
  clearInterval(timerId);
}

function openLookup() {
  stopAdminLiveUpdates();
  lookupOverlay.classList.add("open");
  lookupOverlay.setAttribute("aria-hidden", "false");
  lookupResult.innerHTML = "";
  setLookupMessage("");
  currentAdminCpf = "";
  currentAdminStats = null;
  lookupInput.focus();
}

function closeLookup() {
  stopAdminLiveUpdates();
  lookupOverlay.classList.remove("open");
  lookupOverlay.setAttribute("aria-hidden", "true");
  currentAdminCpf = "";
  currentAdminStats = null;
}

function startCountdown(seconds) {
  clearInterval(timerId);
  let remaining = seconds;

  const render = () => {
    const min = String(Math.floor(remaining / 60)).padStart(2, "0");
    const sec = String(remaining % 60).padStart(2, "0");
    countdown.textContent = `00:${min}:${sec}`;
  };

  render();
  timerId = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) {
      clearInterval(timerId);
      countdown.textContent = "00:00:00";
    }
  }, 1000);
}

function renderPurchaseDetails(purchase) {
  const rows = [
    ["Status", "Compra aprovada"],
    ["Nome", purchase.userName],
    ["Transacao", purchase.transactionId],
    ["E-mail", purchase.email || "-"],
    ["Telefone", purchase.phone || "-"],
    [
      "Feito em",
      new Date(purchase.createdAt).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    ],
    ["Quantidade de cotas", String(purchase.quantity)],
    ["Valor", `R$ ${money(purchase.amount)}`]
  ];

  successDetails.innerHTML = rows
    .map(([label, value]) => `<div class="purchase-line"><span>${label}</span><span>${value}</span></div>`)
    .join("");

  const tickets = [...purchase.tickets].sort((a, b) => Number(a) - Number(b));
  successTicketCount.textContent = String(tickets.length);
  successTickets.innerHTML = tickets.map((ticket) => `<span class="ticket-chip">${ticket}</span>`).join("");
}

function renderUserPurchases(purchases) {
  if (!purchases.length) {
    lookupResult.innerHTML = "<div class='lookup-block'>Nenhuma compra encontrada.</div>";
    return;
  }

  lookupResult.innerHTML = purchases
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((purchase) => {
      const tickets = [...purchase.tickets].sort((a, b) => Number(a) - Number(b));
      return `
      <article class="lookup-block">
        <h6>${purchase.userName}</h6>
        <div class="purchase-line"><span>Transacao</span><span>${purchase.transactionId}</span></div>
        <div class="purchase-line"><span>Data</span><span>${new Date(purchase.createdAt).toLocaleString("pt-BR")}</span></div>
        <div class="purchase-line"><span>Quantidade</span><span>${purchase.quantity}</span></div>
        <div class="purchase-line"><span>Total</span><span>R$ ${money(purchase.amount)}</span></div>
        <div class="ticket-grid">${tickets.map((t) => `<span class="ticket-chip">${t}</span>`).join("")}</div>
      </article>`;
    })
    .join("");
}

function stopAdminLiveUpdates() {
  if (adminPollingId) {
    clearInterval(adminPollingId);
    adminPollingId = null;
  }
}

function renderAdminTicketStatus(statusData) {
  const soldList = Array.isArray(statusData?.soldTicketsSample) ? statusData.soldTicketsSample : [];
  const availableList = Array.isArray(statusData?.availableTicketsSample) ? statusData.availableTicketsSample : [];
  const wrap = document.getElementById("adminLiveStatusWrap");
  if (!wrap) return;

  const soldBadges = soldList.length
    ? soldList.map((t) => `<span class="ticket-chip sold-chip">${t}</span>`).join("")
    : "<span class='status-empty'>Nenhum numero vendido ainda.</span>";
  const availableBadges = availableList.length
    ? availableList.map((t) => `<span class="ticket-chip avail-chip">${t}</span>`).join("")
    : "<span class='status-empty'>Sem numeros disponiveis.</span>";

  wrap.innerHTML = `
    <div class="lookup-block">
      <h6>Tabela de numeros (tempo real)</h6>
      <table class="admin-status-table">
        <thead>
          <tr><th>Status</th><th>Quantidade</th><th>Percentual</th></tr>
        </thead>
        <tbody>
          <tr><td>Vendidos</td><td>${statusData.soldTickets || 0}</td><td>${Number(statusData.progressPercent || 0).toFixed(2)}%</td></tr>
          <tr><td>Disponiveis</td><td>${statusData.remainingTickets || 0}</td><td>${(100 - Number(statusData.progressPercent || 0)).toFixed(2)}%</td></tr>
          <tr><td>Total</td><td>${statusData.totalTickets || 0}</td><td>100.00%</td></tr>
        </tbody>
      </table>
      <p class="admin-live-time">Atualizado em: ${new Date(statusData.updatedAt).toLocaleString("pt-BR")}</p>
      <div class="admin-ticket-lists">
        <div>
          <strong>Ultimos vendidos</strong>
          <div class="ticket-grid">${soldBadges}</div>
        </div>
        <div>
          <strong>Disponiveis (amostra)</strong>
          <div class="ticket-grid">${availableBadges}</div>
        </div>
      </div>
    </div>`;
}

async function refreshAdminLiveStatus() {
  if (!currentAdminCpf) return;
  try {
    const data = await apiRequest(`${API.adminTicketStatus}?cpf=${encodeURIComponent(currentAdminCpf)}`);
    renderAdminTicketStatus(data);
  } catch {
    // silencioso para nao poluir tela enquanto atualiza automatico
  }
}

function startAdminLiveUpdates() {
  stopAdminLiveUpdates();
  refreshAdminLiveStatus();
  adminPollingId = setInterval(refreshAdminLiveStatus, 5000);
}

function renderAdmin(users, stats) {
  currentAdminStats = stats || null;

  if (!users.length) {
    lookupResult.innerHTML = "<div class='lookup-block'>Nenhuma compra registrada ate agora.</div>";
  }

  const sold = Number(stats?.soldTickets || 0);
  const total = Number(stats?.totalTickets || 0);
  const percent = Number(stats?.progressPercent || 0);

  lookupResult.innerHTML = `<h4 class="admin-title">Painel do administrador</h4>
    <div class="lookup-block admin-metrics">
      <div class="admin-config-row">
        <label for="adminTotalTicketsInput">Total de numeros da rifa</label>
        <div class="admin-config-controls">
          <input id="adminTotalTicketsInput" type="number" min="1" max="99999" value="${total || 1}" />
          <button id="saveAdminConfigBtn" class="export-btn" type="button">Salvar total</button>
        </div>
      </div>
      <div class="admin-progress-head">
        <strong>Progresso de vendas</strong>
        <span>${sold} de ${total} (${percent.toFixed(2)}%)</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${Math.max(0, Math.min(100, percent))}%"></div>
      </div>
    </div>
    <div class="admin-tools">
      <button id="exportAdminCsvBtn" class="export-btn" type="button">Exportar CSV</button>
      <button id="exportAdminXlsxBtn" class="export-btn" type="button">Exportar XLSX</button>
    </div>${users
    .map((user) => {
      const tickets = user.purchases.flatMap((purchase) => purchase.tickets).sort((a, b) => Number(a) - Number(b));
      return `
      <article class="lookup-block">
        <h6>${user.name}</h6>
        <div class="purchase-line"><span>CPF</span><span>${maskCpf(user.cpf || "")}</span></div>
        <div class="purchase-line"><span>Telefone</span><span>${user.phone || "-"}</span></div>
        <div class="purchase-line"><span>E-mail</span><span>${user.email || "-"}</span></div>
        <div class="purchase-line"><span>Total de compras</span><span>${user.purchases.length}</span></div>
        <div class="purchase-line"><span>Total de bilhetes</span><span>${tickets.length}</span></div>
        <div class="ticket-grid">${tickets.map((t) => `<span class="ticket-chip">${t}</span>`).join("")}</div>
      </article>`;
    })
    .join("")}
    <div id="adminLiveStatusWrap"></div>`;

  startAdminLiveUpdates();
}

async function createPixCharge(user) {
  const total = quantity * ticketPrice;
  return apiRequest(API.pixCharge, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(total.toFixed(2)),
      quantity,
      description: "Performance que Impoe Respeito - Macan T",
      buyer: {
        name: user.name,
        phone: user.phone,
        cpf: user.cpf || "",
        email: user.email || "",
        birthDate: user.birthDate || ""
      }
    })
  });
}

async function showPayment(user) {
  try {
    const total = quantity * ticketPrice;
    const charge = await createPixCharge(user);

    activeCharge = {
      id: charge.id,
      transactionId: charge.transactionId,
      amount: Number(total.toFixed(2)),
      quantity
    };

    pixCodeInput.value = charge.pixCode;
    qrImage.src = charge.qrCodeImage;

    purchaseName.textContent = user.name;
    purchasePhone.textContent = user.phone;
    purchaseDate.textContent = new Date().toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    purchaseTotal.textContent = money(total);
    setStatus("");
    setStep("stepPayment");
    startCountdown(Number(charge.expiresInSeconds) || 580);
  } catch (error) {
    alert(error.message || "Nao foi possivel criar a cobranca PIX.");
  }
}

quickOptions.forEach((option) => {
  const btn = document.createElement("button");
  btn.className = "quick-btn";
  btn.type = "button";
  btn.textContent = `+${option}`;

  if (option === 200) {
    btn.classList.add("popular");
    const badge = document.createElement("span");
    badge.className = "popular-badge";
    badge.textContent = "Mais popular";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", () => {
    quantity += option;
    updateSummary();
  });

  quickButtons.appendChild(btn);
});

minusBtn.addEventListener("click", () => {
  quantity = Math.max(1, quantity - 1);
  updateSummary();
});

plusBtn.addEventListener("click", () => {
  quantity += 1;
  updateSummary();
});

participarBtn.addEventListener("click", openCheckout);
backBtn.addEventListener("click", closeCheckout);
myTicketsBtn.addEventListener("click", openLookup);

successMyTicketsBtn.addEventListener("click", () => {
  closeCheckout();
  openLookup();
  if (latestPaidPurchase?.phone) {
    activeLookupMethod = "phone";
    lookupTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.method === "phone"));
    lookupLabel.textContent = "Celular com DDD";
    lookupInput.placeholder = "+55 (00) 00000-0000";
    lookupInput.value = latestPaidPurchase.phone;
    lookupContinueBtn.click();
  }
});

phoneContinue.addEventListener("click", async () => {
  if (quantity < minimumPurchase) {
    alert(`A compra minima e de ${minimumPurchase} numeros.`);
    return;
  }

  const phone = phoneInput.value.trim();
  if (!phone) {
    alert("Informe seu telefone para continuar.");
    return;
  }

  try {
    const data = await apiRequest(`${API.userFind}?phone=${encodeURIComponent(phone)}`);
    if (data.user) {
      activeUser = data.user;
      existingName.textContent = data.user.name || "Cliente";
      existingPhone.textContent = data.user.phone || phone;
      setStep("stepExisting");
      return;
    }

    phoneConfirmInput.value = maskPhone(phone);
    setStep("stepRegister");
  } catch (error) {
    alert(error.message || "Erro ao consultar usuario.");
  }
});

existingContinue.addEventListener("click", () => {
  if (!activeUser) return;
  showPayment(activeUser);
});

registerContinue.addEventListener("click", () => {
  if (quantity < minimumPurchase) {
    alert(`A compra minima e de ${minimumPurchase} numeros.`);
    return;
  }

  if (!nameInput.value.trim() || !cpfInput.value.trim() || !phoneConfirmInput.value.trim()) {
    alert("Preencha ao menos nome, CPF e telefone.");
    return;
  }

  activeUser = {
    name: nameInput.value.trim(),
    phone: phoneConfirmInput.value.trim(),
    cpf: onlyDigits(cpfInput.value),
    email: normalizeEmail(emailInput.value),
    birthDate: birthInput.value.trim()
  };

  showPayment(activeUser);
});

copyPixBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pixCodeInput.value);
    copyPixBtn.textContent = "Copiado!";
    setTimeout(() => {
      copyPixBtn.textContent = "Copiar";
    }, 1300);
  } catch {
    alert("Nao foi possivel copiar automaticamente.");
  }
});

verifyStatusBtn.addEventListener("click", async () => {
  if (!activeCharge?.id) {
    setStatus("Cobranca ainda nao foi gerada.", "error");
    return;
  }

  setStatus("Verificando pagamento...", "pending");

  try {
    const data = await apiRequest(`${API.pixConfirm}/${activeCharge.id}`, { method: "POST" });
    const purchase = data.purchase;

    clearInterval(timerId);
    countdown.textContent = "00:00:00";
    setStatus("Pagamento confirmado com sucesso.", "ok");

    latestPaidPurchase = purchase;
    renderPurchaseDetails(purchase);
    setStep("stepSuccess");
  } catch (error) {
    const message = error.message || "Nao foi possivel confirmar agora.";
    if (message.toLowerCase().includes("expirada")) {
      clearInterval(timerId);
      countdown.textContent = "00:00:00";
    }
    setStatus(message, "error");
  }
});

rulesToggle.addEventListener("click", () => {
  const open = rulesContent.classList.toggle("open");
  rulesArrow.textContent = open ? "▴" : "▾";
});

lookupTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    stopAdminLiveUpdates();
    lookupTabs.forEach((other) => other.classList.remove("active"));
    tab.classList.add("active");
    activeLookupMethod = tab.dataset.method;
    lookupResult.innerHTML = "";
    setLookupMessage("");
    currentAdminCpf = "";
    currentAdminStats = null;

    if (activeLookupMethod === "phone") {
      lookupLabel.textContent = "Celular com DDD";
      lookupInput.placeholder = "+55 (00) 00000-0000";
    } else if (activeLookupMethod === "email") {
      lookupLabel.textContent = "Email";
      lookupInput.placeholder = "voce@email.com";
    } else {
      lookupLabel.textContent = "CPF";
      lookupInput.placeholder = "000.000.000-00";
    }

    lookupInput.value = "";
  });
});

lookupContinueBtn.addEventListener("click", async () => {
  stopAdminLiveUpdates();
  lookupResult.innerHTML = "";
  setLookupMessage("");

  const query = lookupInput.value.trim();
  if (!query) {
    setLookupMessage("Informe um valor para consultar.", "error");
    return;
  }

  try {
    if (activeLookupMethod === "cpf") {
      try {
        const adminData = await apiRequest(`${API.adminPurchases}?cpf=${encodeURIComponent(query)}`);
        currentAdminCpf = onlyDigits(query);
        const stats =
          adminData.stats || (await apiRequest(`${API.adminStats}?cpf=${encodeURIComponent(currentAdminCpf)}`));
        renderAdmin(adminData.users || [], stats);
        setLookupMessage("Acesso de administrador liberado.", "ok");
        return;
      } catch {
        // Se nao for admin, segue fluxo normal de busca por CPF.
        currentAdminCpf = "";
      }
    }

    const data = await apiRequest(
      `${API.purchases}?method=${encodeURIComponent(activeLookupMethod)}&query=${encodeURIComponent(query)}`
    );

    const purchases = Array.isArray(data.purchases) ? data.purchases : [];
    if (!purchases.length) {
      setLookupMessage("Nenhuma compra encontrada.", "pending");
      return;
    }

    setLookupMessage(`${purchases.length} compra(s) encontrada(s).`, "ok");
    renderUserPurchases(purchases);
  } catch (error) {
    setLookupMessage(error.message || "Erro ao consultar compras.", "error");
  }
});

closeLookupBtn.addEventListener("click", closeLookup);
lookupOverlay.addEventListener("click", (event) => {
  if (event.target === lookupOverlay) closeLookup();
});

lookupResult.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!currentAdminCpf) {
    setLookupMessage("CPF de administrador nao identificado.", "error");
    return;
  }

  if (target.id === "exportAdminCsvBtn" || target.id === "exportAdminXlsxBtn") {
    (async () => {
      try {
        const format = target.id === "exportAdminXlsxBtn" ? "xlsx" : "csv";
        const response = await fetch(
          `${API.adminExport}?cpf=${encodeURIComponent(currentAdminCpf)}&format=${encodeURIComponent(format)}`
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Erro ao exportar.");
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = format === "xlsx" ? "relatorio_rifa.xlsx" : "relatorio_rifa.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        setLookupMessage("Relatorio exportado com sucesso.", "ok");
      } catch (error) {
        setLookupMessage(error.message || "Erro ao exportar.", "error");
      }
    })();
    return;
  }

  if (target.id === "saveAdminConfigBtn") {
    (async () => {
      const input = document.getElementById("adminTotalTicketsInput");
      const totalTickets = Number(input?.value || 0);
      if (!Number.isInteger(totalTickets) || totalTickets < 1 || totalTickets > 99999) {
        setLookupMessage("Informe um total valido entre 1 e 99999.", "error");
        return;
      }
      try {
        const stats = await apiRequest(API.adminConfig, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cpf: currentAdminCpf, totalTickets })
        });
        currentAdminStats = stats;
        const adminData = await apiRequest(`${API.adminPurchases}?cpf=${encodeURIComponent(currentAdminCpf)}`);
        renderAdmin(adminData.users || [], stats);
        setLookupMessage("Configuracao de total atualizada.", "ok");
      } catch (error) {
        setLookupMessage(error.message || "Erro ao salvar configuracao.", "error");
      }
    })();
  }
});

[phoneInput, phoneConfirmInput].forEach((field) => {
  field.addEventListener("input", () => {
    field.value = maskPhone(field.value);
  });
});

cpfInput.addEventListener("input", () => {
  cpfInput.value = maskCpf(cpfInput.value);
});

birthInput.addEventListener("input", () => {
  birthInput.value = maskDate(birthInput.value);
});

updateSummary();
