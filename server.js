const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const mysql = require("mysql2/promise");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const ROOT = __dirname;

const MIN_PURCHASE = 5;
const CHARGE_EXPIRES_SECONDS = 9 * 60 + 40;

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

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",;\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${lines}</sheetData></worksheet>`;
}

function buildXlsxBuffer(rows) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
        "utf8"
      )
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
        "utf8"
      )
    },
    {
      name: "docProps/core.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Relatorio Rifa</dc:title><dc:creator>Sistema Rifa</dc:creator></cp:coreProperties>`,
        "utf8"
      )
    },
    {
      name: "docProps/app.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Rifa</Application></Properties>`,
        "utf8"
      )
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Relatorio" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "utf8"
      )
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "utf8"
      )
    },
    {
      name: "xl/styles.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`,
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

function dbConfigFromEnv() {
  if (process.env.MYSQL_URL) {
    return process.env.MYSQL_URL;
  }
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "rifa_app",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };
}

const pool = mysql.createPool(dbConfigFromEnv());

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(40) NULL,
      cpf VARCHAR(20) NULL,
      email VARCHAR(255) NULL,
      birth_date VARCHAR(20) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uq_users_phone (phone),
      UNIQUE KEY uq_users_cpf (cpf),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS charges (
      id VARCHAR(64) PRIMARY KEY,
      transaction_id VARCHAR(32) NOT NULL UNIQUE,
      user_id VARCHAR(64) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      quantity INT NOT NULL,
      description VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL,
      pix_code TEXT NOT NULL,
      qr_code_image TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      CONSTRAINT fk_charges_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id VARCHAR(64) PRIMARY KEY,
      charge_id VARCHAR(64) NOT NULL UNIQUE,
      transaction_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      cpf VARCHAR(20) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(40) NULL,
      amount DECIMAL(10,2) NOT NULL,
      quantity INT NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at DATETIME NOT NULL,
      CONSTRAINT fk_purchases_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_purchases_charge FOREIGN KEY (charge_id) REFERENCES charges(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_tickets (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      purchase_id VARCHAR(64) NOT NULL,
      ticket CHAR(5) NOT NULL UNIQUE,
      CONSTRAINT fk_tickets_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id),
      INDEX idx_tickets_purchase (purchase_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_cpfs (
      cpf VARCHAR(11) PRIMARY KEY
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raffle_config (
      id TINYINT PRIMARY KEY,
      total_tickets INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query("INSERT IGNORE INTO raffle_config (id, total_tickets) VALUES (1, 99999)");
  await pool.query("INSERT IGNORE INTO admin_cpfs (cpf) VALUES ('45235958870')");
}

async function isAdmin(cpf) {
  const [rows] = await pool.query("SELECT 1 FROM admin_cpfs WHERE cpf = ? LIMIT 1", [onlyDigits(cpf)]);
  return rows.length > 0;
}

async function getRaffleStats(conn = pool) {
  const [[config]] = await conn.query("SELECT total_tickets AS totalTickets FROM raffle_config WHERE id = 1");
  const [[countRow]] = await conn.query("SELECT COUNT(*) AS soldTickets FROM purchase_tickets");
  const totalTickets = Math.max(1, Math.min(99999, Number(config?.totalTickets || 99999)));
  const soldTickets = Number(countRow?.soldTickets || 0);
  const remainingTickets = Math.max(totalTickets - soldTickets, 0);
  const progressPercent = totalTickets > 0 ? Number(((soldTickets / totalTickets) * 100).toFixed(2)) : 0;
  return { totalTickets, soldTickets, remainingTickets, progressPercent };
}

async function buildAvailabilitySample(limit = 40) {
  const stats = await getRaffleStats();
  const [soldRows] = await pool.query("SELECT ticket FROM purchase_tickets ORDER BY CAST(ticket AS UNSIGNED) ASC");
  const soldSet = new Set(soldRows.map((row) => row.ticket));

  const soldTicketsSample = soldRows.map((row) => row.ticket).slice(-limit);
  const availableTicketsSample = [];
  for (let i = 1; i <= stats.totalTickets && availableTicketsSample.length < limit; i += 1) {
    const ticket = String(i).padStart(5, "0");
    if (!soldSet.has(ticket)) availableTicketsSample.push(ticket);
  }

  return {
    ...stats,
    soldTicketsSample,
    availableTicketsSample,
    updatedAt: new Date().toISOString()
  };
}

async function findUser(query) {
  const cpf = onlyDigits(query.cpf);
  const phone = String(query.phone || "").trim();
  const email = normalizeEmail(query.email);

  const where = [];
  const values = [];
  if (cpf) {
    where.push("cpf = ?");
    values.push(cpf);
  }
  if (phone) {
    where.push("phone = ?");
    values.push(phone);
  }
  if (email) {
    where.push("email = ?");
    values.push(email);
  }

  if (!where.length) return null;

  const [rows] = await pool.query(
    `SELECT id, name, phone, cpf, email, birth_date AS birthDate, created_at AS createdAt, updated_at AS updatedAt
     FROM users
     WHERE ${where.join(" OR ")}
     LIMIT 1`,
    values
  );

  return rows[0] || null;
}

async function upsertUser(conn, input) {
  const clean = {
    name: String(input.name || "Cliente").trim() || "Cliente",
    phone: String(input.phone || "").trim(),
    cpf: onlyDigits(input.cpf || ""),
    email: normalizeEmail(input.email || ""),
    birthDate: String(input.birthDate || "").trim()
  };

  const where = [];
  const values = [];
  if (clean.cpf) {
    where.push("cpf = ?");
    values.push(clean.cpf);
  }
  if (clean.phone) {
    where.push("phone = ?");
    values.push(clean.phone);
  }
  if (clean.email) {
    where.push("email = ?");
    values.push(clean.email);
  }

  let existing = null;
  if (where.length) {
    const [rows] = await conn.query(`SELECT * FROM users WHERE ${where.join(" OR ")} LIMIT 1 FOR UPDATE`, values);
    existing = rows[0] || null;
  }

  const now = new Date();
  if (existing) {
    await conn.query(
      `UPDATE users
       SET name = ?, phone = ?, cpf = ?, email = ?, birth_date = ?, updated_at = ?
       WHERE id = ?`,
      [
        clean.name,
        clean.phone || null,
        clean.cpf || null,
        clean.email || null,
        clean.birthDate || null,
        now,
        existing.id
      ]
    );

    return {
      id: existing.id,
      name: clean.name,
      phone: clean.phone || null,
      cpf: clean.cpf || null,
      email: clean.email || null,
      birthDate: clean.birthDate || null,
      createdAt: existing.created_at,
      updatedAt: now
    };
  }

  const id = createId("user");
  await conn.query(
    `INSERT INTO users (id, name, phone, cpf, email, birth_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, clean.name, clean.phone || null, clean.cpf || null, clean.email || null, clean.birthDate || null, now, now]
  );

  return {
    id,
    name: clean.name,
    phone: clean.phone || null,
    cpf: clean.cpf || null,
    email: clean.email || null,
    birthDate: clean.birthDate || null,
    createdAt: now,
    updatedAt: now
  };
}

async function readTicketsByPurchaseIds(purchaseIds) {
  if (!purchaseIds.length) return new Map();
  const placeholders = purchaseIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT purchase_id AS purchaseId, ticket
     FROM purchase_tickets
     WHERE purchase_id IN (${placeholders})
     ORDER BY CAST(ticket AS UNSIGNED) ASC`,
    purchaseIds
  );

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.purchaseId)) map.set(row.purchaseId, []);
    map.get(row.purchaseId).push(row.ticket);
  }
  return map;
}

async function getPurchasesByFilter(method, query) {
  let clause = "";
  let value = query;
  if (method === "phone") {
    clause = "phone = ?";
  } else if (method === "email") {
    clause = "LOWER(email) = ?";
    value = normalizeEmail(query);
  } else if (method === "cpf") {
    clause = "cpf = ?";
    value = onlyDigits(query);
  } else {
    return [];
  }

  const [rows] = await pool.query(
    `SELECT id, charge_id AS chargeId, transaction_id AS transactionId, user_id AS userId, user_name AS userName,
            cpf, email, phone, amount, quantity, status, created_at AS createdAt
     FROM purchases
     WHERE ${clause}
     ORDER BY created_at DESC`,
    [value]
  );

  const purchaseIds = rows.map((r) => r.id);
  const ticketsMap = await readTicketsByPurchaseIds(purchaseIds);
  return rows.map((row) => ({ ...row, tickets: ticketsMap.get(row.id) || [] }));
}

async function getAdminGroupedPurchases() {
  const [rows] = await pool.query(
    `SELECT id, charge_id AS chargeId, transaction_id AS transactionId, user_id AS userId, user_name AS userName,
            cpf, email, phone, amount, quantity, status, created_at AS createdAt
     FROM purchases
     ORDER BY created_at DESC`
  );

  const purchaseIds = rows.map((r) => r.id);
  const ticketsMap = await readTicketsByPurchaseIds(purchaseIds);

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.userId]) {
      grouped[row.userId] = {
        userId: row.userId,
        name: row.userName,
        cpf: row.cpf,
        phone: row.phone,
        email: row.email,
        purchases: []
      };
    }
    grouped[row.userId].purchases.push({ ...row, tickets: ticketsMap.get(row.id) || [] });
  }

  return Object.values(grouped);
}

async function createCharge({ amount, quantity, buyer, description }) {
  return withTransaction(async (conn) => {
    const stats = await getRaffleStats(conn);
    if (stats.remainingTickets < quantity) {
      throw new Error("INSUFFICIENT_TICKETS");
    }

    const user = await upsertUser(conn, buyer);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CHARGE_EXPIRES_SECONDS * 1000);
    const pixCode = createPixCode(user.name);

    const charge = {
      id: createId("charge"),
      transactionId: createTransactionCode(),
      userId: user.id,
      amount: Number(amount.toFixed(2)),
      quantity,
      description,
      status: "pending",
      pixCode,
      qrCodeImage: `https://api.qrserver.com/v1/create-qr-code/?size=480x480&data=${encodeURIComponent(pixCode)}`,
      createdAt,
      expiresAt
    };

    await conn.query(
      `INSERT INTO charges (id, transaction_id, user_id, amount, quantity, description, status, pix_code, qr_code_image, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        charge.id,
        charge.transactionId,
        charge.userId,
        charge.amount,
        charge.quantity,
        charge.description,
        charge.status,
        charge.pixCode,
        charge.qrCodeImage,
        charge.createdAt,
        charge.expiresAt
      ]
    );

    return charge;
  });
}

async function getChargeStatus(chargeId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query("SELECT id, status, expires_at AS expiresAt FROM charges WHERE id = ? LIMIT 1 FOR UPDATE", [
      chargeId
    ]);
    const charge = rows[0] || null;
    if (!charge) return null;

    if (charge.status === "pending" && Date.now() > new Date(charge.expiresAt).getTime()) {
      await conn.query("UPDATE charges SET status = 'expired' WHERE id = ?", [charge.id]);
      charge.status = "expired";
    }

    return { id: charge.id, status: charge.status };
  });
}

async function confirmChargePayment(chargeId) {
  return withTransaction(async (conn) => {
    const [[config]] = await conn.query("SELECT total_tickets AS totalTickets FROM raffle_config WHERE id = 1 FOR UPDATE");
    const totalTickets = Math.max(1, Math.min(99999, Number(config?.totalTickets || 99999)));

    const [chargeRows] = await conn.query(
      "SELECT id, transaction_id AS transactionId, user_id AS userId, amount, quantity, status, expires_at AS expiresAt FROM charges WHERE id = ? LIMIT 1 FOR UPDATE",
      [chargeId]
    );

    const charge = chargeRows[0] || null;
    if (!charge) throw new Error("CHARGE_NOT_FOUND");

    if (charge.status === "pending" && Date.now() > new Date(charge.expiresAt).getTime()) {
      await conn.query("UPDATE charges SET status = 'expired' WHERE id = ?", [charge.id]);
      charge.status = "expired";
    }

    if (charge.status === "expired") throw new Error("CHARGE_EXPIRED");

    const [existingRows] = await conn.query(
      `SELECT id, charge_id AS chargeId, transaction_id AS transactionId, user_id AS userId, user_name AS userName,
              cpf, email, phone, amount, quantity, status, created_at AS createdAt
       FROM purchases WHERE charge_id = ? LIMIT 1`,
      [charge.id]
    );

    if (existingRows[0]) {
      const existing = existingRows[0];
      const [ticketRows] = await conn.query(
        "SELECT ticket FROM purchase_tickets WHERE purchase_id = ? ORDER BY CAST(ticket AS UNSIGNED) ASC",
        [existing.id]
      );
      if (charge.status !== "paid") await conn.query("UPDATE charges SET status = 'paid' WHERE id = ?", [charge.id]);
      return { ...existing, tickets: ticketRows.map((row) => row.ticket) };
    }

    if (charge.status !== "pending") throw new Error("CHARGE_INVALID_STATUS");

    const [[countRow]] = await conn.query("SELECT COUNT(*) AS soldTickets FROM purchase_tickets");
    const soldTickets = Number(countRow?.soldTickets || 0);
    if (soldTickets + Number(charge.quantity) > totalTickets) throw new Error("SOLD_OUT");

    const [userRows] = await conn.query(
      "SELECT id, name, cpf, email, phone FROM users WHERE id = ? LIMIT 1",
      [charge.userId]
    );
    const user = userRows[0];
    if (!user) throw new Error("USER_NOT_FOUND");

    const tickets = [];
    const picked = new Set();
    let attempts = 0;
    const maxAttempts = charge.quantity * 3000;

    while (tickets.length < charge.quantity && attempts < maxAttempts) {
      attempts += 1;
      const ticket = String(Math.floor(Math.random() * totalTickets) + 1).padStart(5, "0");
      if (picked.has(ticket)) continue;
      const [existsRows] = await conn.query("SELECT 1 FROM purchase_tickets WHERE ticket = ? LIMIT 1", [ticket]);
      if (existsRows.length) continue;
      picked.add(ticket);
      tickets.push(ticket);
    }

    if (tickets.length < charge.quantity) throw new Error("SOLD_OUT");

    const purchaseId = createId("purchase");
    const createdAt = new Date();

    await conn.query(
      `INSERT INTO purchases
       (id, charge_id, transaction_id, user_id, user_name, cpf, email, phone, amount, quantity, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`,
      [
        purchaseId,
        charge.id,
        charge.transactionId,
        user.id,
        user.name,
        user.cpf,
        user.email,
        user.phone,
        charge.amount,
        charge.quantity,
        createdAt
      ]
    );

    for (const ticket of tickets) {
      await conn.query("INSERT INTO purchase_tickets (purchase_id, ticket) VALUES (?, ?)", [purchaseId, ticket]);
    }

    await conn.query("UPDATE charges SET status = 'paid' WHERE id = ?", [charge.id]);

    return {
      id: purchaseId,
      chargeId: charge.id,
      transactionId: charge.transactionId,
      userId: user.id,
      userName: user.name,
      cpf: user.cpf,
      email: user.email,
      phone: user.phone,
      amount: Number(charge.amount),
      quantity: Number(charge.quantity),
      status: "paid",
      createdAt,
      tickets: tickets.sort((a, b) => Number(a) - Number(b))
    };
  });
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

function sendCsv(res, filename, csvContent) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename=\"${filename}\"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
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

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Payload muito grande."));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/raffle/stats") {
    return json(res, 200, await getRaffleStats());
  }

  if (req.method === "GET" && url.pathname === "/api/users/find") {
    const user = await findUser({
      phone: url.searchParams.get("phone"),
      email: url.searchParams.get("email"),
      cpf: url.searchParams.get("cpf")
    });
    return json(res, 200, { user });
  }

  if (req.method === "POST" && url.pathname === "/api/users/upsert") {
    const body = await parseJsonBody(req);
    const user = await withTransaction((conn) => upsertUser(conn, body));
    return json(res, 200, { user });
  }

  if (req.method === "POST" && url.pathname === "/api/pix/charge") {
    const body = await parseJsonBody(req);
    const amount = Number(body.amount || 0);
    const quantity = Number(body.quantity || 0);
    const buyer = body.buyer || {};

    if (!buyer.phone) return badRequest(res, "Telefone e obrigatorio.");
    if (quantity < MIN_PURCHASE) return badRequest(res, `Compra minima de ${MIN_PURCHASE} numeros.`);
    if (!(amount > 0)) return badRequest(res, "Valor invalido.");

    try {
      const charge = await createCharge({
        amount,
        quantity,
        buyer,
        description: String(body.description || "Rifa")
      });

      return json(res, 200, {
        id: charge.id,
        transactionId: charge.transactionId,
        pixCode: charge.pixCode,
        qrCodeImage: charge.qrCodeImage,
        expiresInSeconds: CHARGE_EXPIRES_SECONDS
      });
    } catch (error) {
      if (error.message === "INSUFFICIENT_TICKETS") {
        return json(res, 409, { error: "Quantidade indisponivel. Limite de numeros da rifa atingido." });
      }
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/pix/status/")) {
    const chargeId = url.pathname.replace("/api/pix/status/", "");
    const payload = await getChargeStatus(chargeId);
    if (!payload) return notFound(res);
    return json(res, 200, payload);
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/pix/confirm/")) {
    const chargeId = url.pathname.replace("/api/pix/confirm/", "");
    try {
      const purchase = await confirmChargePayment(chargeId);
      return json(res, 200, { purchase });
    } catch (error) {
      if (error.message === "CHARGE_NOT_FOUND") return notFound(res);
      if (error.message === "CHARGE_EXPIRED") return json(res, 409, { error: "Cobranca expirada." });
      if (error.message === "CHARGE_INVALID_STATUS") return json(res, 409, { error: "Cobranca em estado invalido." });
      if (error.message === "SOLD_OUT") return json(res, 409, { error: "Nao ha numeros suficientes disponiveis para concluir esta compra." });
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/purchases") {
    const method = String(url.searchParams.get("method") || "").toLowerCase();
    const query = String(url.searchParams.get("query") || "");
    if (!method || !query) return badRequest(res, "Informe method e query.");
    const purchases = await getPurchasesByFilter(method, query);
    return json(res, 200, { purchases });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/purchases") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    if (!(await isAdmin(cpf))) return json(res, 403, { error: "CPF sem permissao de administrador." });
    const users = await getAdminGroupedPurchases();
    const stats = await getRaffleStats();
    return json(res, 200, { users, stats });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/stats") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    if (!(await isAdmin(cpf))) return json(res, 403, { error: "CPF sem permissao de administrador." });
    return json(res, 200, await getRaffleStats());
  }

  if (req.method === "GET" && url.pathname === "/api/admin/ticket-status") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    if (!(await isAdmin(cpf))) return json(res, 403, { error: "CPF sem permissao de administrador." });
    return json(res, 200, await buildAvailabilitySample());
  }

  if (req.method === "POST" && url.pathname === "/api/admin/config") {
    const body = await parseJsonBody(req);
    const cpf = onlyDigits(body.cpf || "");
    const requestedTotal = Number(body.totalTickets);

    if (!(await isAdmin(cpf))) return json(res, 403, { error: "CPF sem permissao de administrador." });
    if (!Number.isInteger(requestedTotal) || requestedTotal < 1 || requestedTotal > 99999) {
      return badRequest(res, "totalTickets deve ser um inteiro entre 1 e 99999.");
    }

    try {
      const result = await withTransaction(async (conn) => {
        await conn.query("SELECT id FROM raffle_config WHERE id = 1 FOR UPDATE");
        const [[countRow]] = await conn.query("SELECT COUNT(*) AS soldTickets FROM purchase_tickets");
        const sold = Number(countRow?.soldTickets || 0);
        if (requestedTotal < sold) throw new Error("LOWER_THAN_SOLD");
        await conn.query("UPDATE raffle_config SET total_tickets = ? WHERE id = 1", [requestedTotal]);
        return getRaffleStats(conn);
      });
      return json(res, 200, result);
    } catch (error) {
      if (error.message === "LOWER_THAN_SOLD") {
        return json(res, 409, { error: "O total nao pode ser menor que os numeros ja vendidos." });
      }
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/admin/export") {
    const cpf = onlyDigits(url.searchParams.get("cpf") || "");
    if (!(await isAdmin(cpf))) return json(res, 403, { error: "CPF sem permissao de administrador." });

    const [purchaseRows] = await pool.query(
      `SELECT p.id, p.charge_id AS chargeId, p.transaction_id AS transactionId, p.user_id AS userId, p.user_name AS userName,
              p.cpf, p.email, p.phone, p.amount, p.quantity, p.status, p.created_at AS createdAt, u.created_at AS userCreatedAt
       FROM purchases p
       LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC`
    );

    const ticketsMap = await readTicketsByPurchaseIds(purchaseRows.map((row) => row.id));

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

    const dataRows = purchaseRows.map((row) => [
      row.userId,
      row.userName,
      row.cpf || "",
      row.phone || "",
      row.email || "",
      row.userCreatedAt || "",
      row.id,
      row.chargeId,
      row.transactionId,
      row.status,
      row.createdAt,
      Number(row.quantity),
      Number(row.amount),
      (ticketsMap.get(row.id) || []).join("|")
    ]);

    const allRows = [headers, ...dataRows];
    const format = String(url.searchParams.get("format") || "csv").toLowerCase();

    if (format === "xlsx") {
      const xlsxBuffer = buildXlsxBuffer(allRows);
      return sendBinary(
        res,
        "relatorio_rifa.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        xlsxBuffer
      );
    }

    const csv = allRows.map((line) => line.map(csvEscape).join(";")).join("\n");
    return sendCsv(res, "relatorio_rifa.csv", csv);
  }

  return notFound(res);
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
  if (!filePath.startsWith(ROOT)) return notFound(res);

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeByExt(filePath) });
    res.end(data);
  } catch {
    notFound(res);
  }
}

const app = express();

app.use(async (req, res) => {
  try {
    const url = new URL(req.originalUrl || req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    return json(res, 500, { error: "Erro interno do servidor.", detail: error.message });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Servidor iniciado em http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao inicializar banco MySQL:", error.message);
    process.exit(1);
  });
