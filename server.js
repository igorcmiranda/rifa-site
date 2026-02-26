const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const MIN_PURCHASE = 5;
const CHARGE_EXPIRES_SECONDS = 9 * 60 + 40;

let writeQueue = Promise.resolve();

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value) {
  return onlyDigits(value);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e8)}`;
}

function createTransactionCode() {
  return createId("tx").replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
}

function createPixCode(name) {
  const safeName = String(name || "Cliente").slice(0, 24).padEnd(24, " ");
  return `00020126580014br.gov.bcb.pix0136rifa.exemplo/${Date.now()}5204000053039865802BR5925${safeName}6008BRASILIA62070503***6304ABCD`;
}

function buildDb() {
  return {
    adminCpfs: ["45235958870"],
    raffle: {
      totalTickets: 99999
    },
    users: [],
    charges: [],
    purchases: [],
    usedTickets: []
  };
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(buildDb(), null, 2), "utf8");
  }
}

async function readDb() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      adminCpfs: Array.isArray(parsed.adminCpfs) ? parsed.adminCpfs : ["45235958870"],
      raffle: {
        totalTickets: Number(parsed?.raffle?.totalTickets) > 0 ? Number(parsed.raffle.totalTickets) : 99999
      },
      users: Array.isArray(parsed.users) ? parsed.users : [],
      charges: Array.isArray(parsed.charges) ? parsed.charges : [],
      purchases: Array.isArray(parsed.purchases) ? parsed.purchases : [],
      usedTickets: Array.isArray(parsed.usedTickets) ? parsed.usedTickets : []
    };
  } catch {
    return buildDb();
  }
}

async function writeDb(db) {
  await ensureDataFile();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function withDbWrite(mutator) {
  writeQueue = writeQueue.then(async () => {
    const db = await readDb();
    const output = await mutator(db);
    await writeDb(db);
    return output;
  });
  return writeQueue;
}

function getRaffleStats(db) {
  const totalTickets = Math.max(1, Math.min(99999, Number(db?.raffle?.totalTickets) || 99999));
  const soldTickets = Array.isArray(db.usedTickets) ? db.usedTickets.length : 0;
  const remainingTickets = Math.max(totalTickets - soldTickets, 0);
  const progressPercent = totalTickets > 0 ? Number(((soldTickets / totalTickets) * 100).toFixed(2)) : 0;
  return { totalTickets, soldTickets, remainingTickets, progressPercent };
}

function buildAvailabilitySample(db, limit = 40) {
  const stats = getRaffleStats(db);
  const soldSet = new Set(db.usedTickets || []);
  const soldTicketsSorted = Array.from(soldSet).sort((a, b) => Number(a) - Number(b));
  const availableTickets = [];

  for (let i = 1; i <= stats.totalTickets && availableTickets.length < limit; i += 1) {
    const ticket = String(i).padStart(5, "0");
    if (!soldSet.has(ticket)) availableTickets.push(ticket);
  }

  return {
    ...stats,
    soldTicketsSample: soldTicketsSorted.slice(-limit),
    availableTicketsSample: availableTickets,
    updatedAt: new Date().toISOString()
  };
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",;\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function sendCsv(res, filename, csvContent) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename=\"${filename}\"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  // BOM para o Excel abrir UTF-8 corretamente
  res.end(`\uFEFF${csvContent}`);
}

function sendBinary(res, filename, mimeType, buffer) {
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Disposition": `attachment; filename=\"${filename}\"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(buffer);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSheetXml(rows) {
  const lines = rows
    .map((row, idx) => {
      const cells = row
        .map((cell, cellIdx) => {
          const col = String.fromCharCode(65 + cellIdx);
          const ref = `${col}${idx + 1}`;
          if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${idx + 1}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${lines}</sheetData>
</worksheet>`;
}

function buildXlsxBuffer(rows) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
        "utf8"
      )
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
        "utf8"
      )
    },
    {
      name: "docProps/core.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Relatorio Rifa</dc:title>
  <dc:creator>Sistema Rifa</dc:creator>
</cp:coreProperties>`,
        "utf8"
      )
    },
    {
      name: "docProps/app.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Rifa</Application>
</Properties>`,
        "utf8"
      )
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Relatorio" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
        "utf8"
      )
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
        "utf8"
      )
    },
    {
      name: "xl/styles.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="1"><xf xfId="0"/></cellXfs>
</styleSheet>`,
        "utf8"
      )
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(buildSheetXml(rows), "utf8")
    }
  ];

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const dataBuf = file.data;
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralPart.length, 12);
  endRecord.writeUInt32LE(localPart.length, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, endRecord]);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload muito grande."));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}

function findUser(db, query) {
  const cpf = onlyDigits(query.cpf);
  const phone = normalizePhone(query.phone);
  const email = normalizeEmail(query.email);

  return (
    db.users.find((user) => {
      return (
        (cpf && onlyDigits(user.cpf) === cpf) ||
        (phone && normalizePhone(user.phone) === phone) ||
        (email && normalizeEmail(user.email) === email)
      );
    }) || null
  );
}

function upsertUser(db, input) {
  const clean = {
    id: "",
    name: String(input.name || "Cliente").trim() || "Cliente",
    phone: String(input.phone || "").trim(),
    cpf: onlyDigits(input.cpf || ""),
    email: normalizeEmail(input.email || ""),
    birthDate: String(input.birthDate || "").trim(),
    updatedAt: new Date().toISOString()
  };

  const found = findUser(db, clean);
  if (found) {
    const merged = {
      ...found,
      ...clean,
      id: found.id,
      createdAt: found.createdAt || new Date().toISOString()
    };
    const idx = db.users.findIndex((u) => u.id === found.id);
    db.users[idx] = merged;
    return merged;
  }

  const created = {
    ...clean,
    id: createId("user"),
    createdAt: new Date().toISOString()
  };
  db.users.push(created);
  return created;
}

function drawUniqueTickets(db, count) {
  const { totalTickets, soldTickets } = getRaffleStats(db);
  if (soldTickets + count > totalTickets) {
    throw new Error("SOLD_OUT");
  }

  const used = new Set(db.usedTickets);
  const tickets = [];
  let attempts = 0;
  const maxAttempts = count * 2000;

  while (tickets.length < count && attempts < maxAttempts) {
    attempts += 1;
    const ticketNumber = Math.floor(Math.random() * totalTickets) + 1;
    const ticket = String(ticketNumber).padStart(5, "0");
    if (!used.has(ticket)) {
      used.add(ticket);
      tickets.push(ticket);
    }
  }

  if (tickets.length < count) {
    throw new Error("SOLD_OUT");
  }

  db.usedTickets = Array.from(used);
  return tickets;
}

function updateExpiredCharge(charge) {
  if (charge.status !== "pending") return;
  if (Date.now() > new Date(charge.expiresAt).getTime()) {
    charge.status = "expired";
  }
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/raffle/stats") {
    const db = await readDb();
    json(res, 200, getRaffleStats(db));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users/find") {
    const db = await readDb();
    const user = findUser(db, {
      phone: url.searchParams.get("phone"),
      email: url.searchParams.get("email"),
      cpf: url.searchParams.get("cpf")
    });
    json(res, 200, { user });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users/upsert") {
    const body = await parseJsonBody(req);
    const user = await withDbWrite(async (db) => upsertUser(db, body));
    json(res, 200, { user });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pix/charge") {
    const body = await parseJsonBody(req);
    const amount = Number(body.amount || 0);
    const quantity = Number(body.quantity || 0);
    const buyer = body.buyer || {};

    if (!buyer.phone) {
      badRequest(res, "Telefone e obrigatorio.");
      return;
    }
    if (quantity < MIN_PURCHASE) {
      badRequest(res, `Compra minima de ${MIN_PURCHASE} numeros.`);
      return;
    }
    if (!(amount > 0)) {
      badRequest(res, "Valor invalido.");
      return;
    }

    let charge;
    try {
      charge = await withDbWrite(async (db) => {
        const stats = getRaffleStats(db);
        if (stats.remainingTickets < quantity) {
          throw new Error("INSUFFICIENT_TICKETS");
        }

        const user = upsertUser(db, buyer);
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + CHARGE_EXPIRES_SECONDS * 1000);
        const pixCode = createPixCode(user.name);
        const chargeData = {
          id: createId("charge"),
          transactionId: createTransactionCode(),
          userId: user.id,
          amount: Number(amount.toFixed(2)),
          quantity,
          description: String(body.description || "Rifa"),
          status: "pending",
          pixCode,
          qrCodeImage: `https://api.qrserver.com/v1/create-qr-code/?size=480x480&data=${encodeURIComponent(pixCode)}`,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString()
        };
        db.charges.push(chargeData);
        return chargeData;
      });
    } catch (error) {
      if (error.message === "INSUFFICIENT_TICKETS") {
        json(res, 409, { error: "Quantidade indisponivel. Limite de numeros da rifa atingido." });
        return;
      }
      throw error;
    }

    json(res, 200, {
      id: charge.id,
      transactionId: charge.transactionId,
      pixCode: charge.pixCode,
      qrCodeImage: charge.qrCodeImage,
      expiresInSeconds: CHARGE_EXPIRES_SECONDS
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/pix/status/")) {
    const chargeId = url.pathname.replace("/api/pix/status/", "");
    const payload = await withDbWrite(async (db) => {
      const charge = db.charges.find((item) => item.id === chargeId);
      if (!charge) return null;
      updateExpiredCharge(charge);
      return { status: charge.status, id: charge.id };
    });

    if (!payload) {
      notFound(res);
      return;
    }
    json(res, 200, payload);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/pix/confirm/")) {
    const chargeId = url.pathname.replace("/api/pix/confirm/", "");

    try {
      const purchase = await withDbWrite(async (db) => {
        const charge = db.charges.find((item) => item.id === chargeId);
        if (!charge) {
          throw new Error("CHARGE_NOT_FOUND");
        }

        updateExpiredCharge(charge);

        if (charge.status === "expired") {
          throw new Error("CHARGE_EXPIRED");
        }

        const existing = db.purchases.find((p) => p.chargeId === charge.id);
        if (existing) {
          charge.status = "paid";
          return existing;
        }

        if (charge.status !== "pending") {
          throw new Error("CHARGE_INVALID_STATUS");
        }

        const user = db.users.find((item) => item.id === charge.userId);
        if (!user) {
          throw new Error("USER_NOT_FOUND");
        }

        const tickets = drawUniqueTickets(db, charge.quantity);

        const purchase = {
          id: createId("purchase"),
          chargeId: charge.id,
          transactionId: charge.transactionId,
          userId: user.id,
          userName: user.name,
          cpf: user.cpf,
          email: user.email,
          phone: user.phone,
          amount: charge.amount,
          quantity: charge.quantity,
          status: "paid",
          createdAt: new Date().toISOString(),
          tickets
        };

        db.purchases.push(purchase);
        charge.status = "paid";

        return purchase;
      });

      json(res, 200, { purchase });
    } catch (error) {
      if (error.message === "CHARGE_NOT_FOUND") {
        notFound(res);
        return;
      }
      if (error.message === "CHARGE_EXPIRED") {
        json(res, 409, { error: "Cobranca expirada." });
        return;
      }
      if (error.message === "CHARGE_INVALID_STATUS") {
        json(res, 409, { error: "Cobranca em estado invalido." });
        return;
      }
      if (error.message === "SOLD_OUT") {
        json(res, 409, { error: "Nao ha numeros suficientes disponiveis para concluir esta compra." });
        return;
      }
      json(res, 500, { error: "Erro ao confirmar pagamento." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/purchases") {
    const method = String(url.searchParams.get("method") || "").toLowerCase();
    const query = String(url.searchParams.get("query") || "");
    if (!method || !query) {
      badRequest(res, "Informe method e query.");
      return;
    }

    const db = await readDb();
    const filtered = db.purchases.filter((purchase) => {
      if (method === "phone") return normalizePhone(purchase.phone) === normalizePhone(query);
      if (method === "email") return normalizeEmail(purchase.email) === normalizeEmail(query);
      if (method === "cpf") return onlyDigits(purchase.cpf) === onlyDigits(query);
      return false;
    });

    json(res, 200, { purchases: filtered });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/purchases") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    const db = await readDb();

    if (!db.adminCpfs.includes(cpf)) {
      json(res, 403, { error: "CPF sem permissao de administrador." });
      return;
    }

    const grouped = db.purchases.reduce((acc, purchase) => {
      if (!acc[purchase.userId]) {
        acc[purchase.userId] = {
          userId: purchase.userId,
          name: purchase.userName,
          cpf: purchase.cpf,
          phone: purchase.phone,
          email: purchase.email,
          purchases: []
        };
      }
      acc[purchase.userId].purchases.push(purchase);
      return acc;
    }, {});

    json(res, 200, { users: Object.values(grouped), stats: getRaffleStats(db) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/stats") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    const db = await readDb();

    if (!db.adminCpfs.includes(cpf)) {
      json(res, 403, { error: "CPF sem permissao de administrador." });
      return;
    }

    json(res, 200, getRaffleStats(db));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/ticket-status") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    const db = await readDb();

    if (!db.adminCpfs.includes(cpf)) {
      json(res, 403, { error: "CPF sem permissao de administrador." });
      return;
    }

    json(res, 200, buildAvailabilitySample(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/config") {
    const body = await parseJsonBody(req);
    const cpf = onlyDigits(body.cpf || "");
    const requestedTotal = Number(body.totalTickets);

    if (!Number.isInteger(requestedTotal) || requestedTotal < 1 || requestedTotal > 99999) {
      badRequest(res, "totalTickets deve ser um inteiro entre 1 e 99999.");
      return;
    }

    const result = await withDbWrite(async (db) => {
      if (!db.adminCpfs.includes(cpf)) {
        throw new Error("NOT_ADMIN");
      }
      const stats = getRaffleStats(db);
      if (requestedTotal < stats.soldTickets) {
        throw new Error("LOWER_THAN_SOLD");
      }
      db.raffle = { totalTickets: requestedTotal };
      return getRaffleStats(db);
    }).catch((error) => {
      if (error.message === "NOT_ADMIN") {
        json(res, 403, { error: "CPF sem permissao de administrador." });
        return null;
      }
      if (error.message === "LOWER_THAN_SOLD") {
        json(res, 409, { error: "O total nao pode ser menor que os numeros ja vendidos." });
        return null;
      }
      throw error;
    });

    if (!result) return;
    json(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/export") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    const db = await readDb();

    if (!db.adminCpfs.includes(cpf)) {
      json(res, 403, { error: "CPF sem permissao de administrador." });
      return;
    }

    const headers = [
      "user_id",
      "nome",
      "cpf",
      "telefone",
      "email",
      "user_created_at",
      "purchase_id",
      "charge_id",
      "transaction_id",
      "purchase_status",
      "purchase_created_at",
      "quantidade",
      "valor",
      "tickets"
    ];

    const rows = db.purchases.map((purchase) => {
      const user = db.users.find((item) => item.id === purchase.userId) || {};
      return [
        purchase.userId,
        purchase.userName || user.name || "",
        purchase.cpf || user.cpf || "",
        purchase.phone || user.phone || "",
        purchase.email || user.email || "",
        user.createdAt || "",
        purchase.id,
        purchase.chargeId || "",
        purchase.transactionId || "",
        purchase.status || "",
        purchase.createdAt || "",
        purchase.quantity || 0,
        purchase.amount || 0,
        Array.isArray(purchase.tickets) ? purchase.tickets.join("|") : ""
      ];
    });

    const allRows = [headers, ...rows];
    const format = String(url.searchParams.get("format") || "csv").toLowerCase();

    if (format === "xlsx") {
      const xlsxBuffer = buildXlsxBuffer(allRows);
      sendBinary(
        res,
        "relatorio_rifa.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        xlsxBuffer
      );
      return;
    }

    const csv = allRows.map((line) => line.map(csvEscape).join(";")).join("\n");
    sendCsv(res, "relatorio_rifa.csv", csv);
    return;
  }

  notFound(res);
}

function contentTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    notFound(res);
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeByExt(filePath) });
    res.end(data);
  } catch {
    notFound(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    json(res, 500, { error: "Erro interno do servidor.", detail: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});
