/* =================================================================
   Bank SMS parser (MBL)

   Turns a bank message like
     "PKR 2,398.00 charged at CHEEZIOUS 05111 as internet purchase, from A/C xxx1521
      (I-8 MARKAZ BR ISD) on 02-Nov-2026 at 07:18 TID:526754"
   into
     { direction: "out", amount: 2398, counterparty: "CHEEZIOUS 05111",
       kind: "Online purchase", occurredOn: "2026-11-02", time: "07:18", reference: "526754" }

   Messages that aren't transactions (OTPs, promotions) give null.
   Everything is exposed as window.BankSms.
   ================================================================= */

(function (global) {
  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  // The local calendar date of a timestamp, as "YYYY-MM-DD".
  function localDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function clean(text) {
    return text ? text.replace(/\s+/g, " ").replace(/[\s.,;:]+$/, "").trim() : null;
  }

  function parseBankSms(body, receivedAt) {
    if (!body) return null;
    const text = body.replace(/\s+/g, " ").trim();

    // Never treat one-time passwords or security messages as transactions.
    if (/\bOTP\b|one[- ]time (?:password|pin)|verification code|do not share/i.test(text)) return null;

    const amountMatch = text.match(/\b(?:PKR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!amountMatch) return null;
    const amount = Number(amountMatch[1].replace(/,/g, ""));
    if (!(amount > 0)) return null;

    let direction = null;
    let counterparty = null;
    let kind = null;
    let m;

    if ((m = text.match(/\bsent to (.+?)(?:\s+PK\d{2}\S*)?\s+as\s/i))) {
      // "PKR 63,250.00 sent to S.MUHAMMAD PK18FAYSxx355 as RAAST payment from your AC# ..."
      direction = "out";
      counterparty = m[1];
      kind = /RAAST/i.test(text) ? "Raast transfer" : "Transfer";
    } else if ((m = text.match(/\bcharged at (.+?)\s+as\s+(.+?)(?:,|\s+from\b)/i))) {
      // "PKR 2,398.00 charged at CHEEZIOUS 05111 as internet purchase, from A/C ..."
      direction = "out";
      counterparty = m[1];
      kind = /internet|online/i.test(m[2]) ? "Online purchase" : "Card purchase";
    } else if ((m = text.match(/\bdebited as (.+?)\s+from your/i))) {
      // "PKR 2,360.00 is debited as SNGPL 26769330007 from your A/C ..."
      direction = "out";
      counterparty = m[1];
      kind = "Bill or top-up";
    } else if ((m = text.match(/\breceived from (.+?)(?:\s+\(|\s+AC#|\s+A\/C|\s+to your)/i))) {
      // "PKR 15,000.00 received from FAIQA JAVED/YOUSUF WASI (MBL ACxxx6596) to your A/C ..."
      // "PKR 4,000.00 received from Y.WASI AC# xxxPYMT ... as RAAST payment to your AC# ..."
      direction = "in";
      counterparty = m[1];
      kind = /RAAST/i.test(text) ? "Raast transfer" : "Bank transfer";
    } else if ((m = text.match(/\bcash withdrawn (?:from|at) (.+?)(?:\s+from\s+(?:your\s+)?A\/?C\b|\s+on\s+\d|$)/i))) {
      // "PKR 10,035.00 cash withdrawn from 1Link ATM from A/C xxx1521 ..."
      // "PKR 10,000.00 cash withdrawn from I-8 MARKAZ BR ISD from A/C xxx1521 ..." (at the branch)
      // Always named "CASH WITHDRAWAL" so one rule covers every ATM and branch.
      direction = "out";
      counterparty = `CASH WITHDRAWAL (${clean(m[1])})`;
      kind = "Cash withdrawal";
    } else if (/\bwithdr[ae]wn?\b|\bwithdrawal\b/i.test(text)) {
      // Any other wording of a withdrawal.
      direction = "out";
      counterparty = "CASH WITHDRAWAL";
      kind = "Cash withdrawal";
    } else if (/\b(?:debited|deducted|paid)\b/i.test(text)) {
      direction = "out";
      kind = "Payment";
    } else if (/\b(?:credited|deposited)\b/i.test(text)) {
      direction = "in";
      kind = "Deposit";
    } else {
      return null;
    }

    // Date and time from the message ("on 02-Nov-2026 at 07:18"), or when it arrived.
    let occurredOn = receivedAt ? localDate(receivedAt) : null;
    let time = null;
    const dateMatch = text.match(/\bon (\d{1,2})-([A-Za-z]{3})-(\d{4})(?: at (\d{1,2}):(\d{2}))?/);
    if (dateMatch && MONTHS[dateMatch[2].toUpperCase()]) {
      occurredOn = `${dateMatch[3]}-${pad(MONTHS[dateMatch[2].toUpperCase()])}-${pad(dateMatch[1])}`;
      if (dateMatch[4]) time = `${pad(dateMatch[4])}:${dateMatch[5]}`;
    }
    if (!occurredOn) return null;

    const referenceMatch = text.match(/\bTID[:\s]*(\d+)/i);

    return {
      direction,
      amount,
      counterparty: clean(counterparty),
      kind,
      occurredOn,
      time,
      reference: referenceMatch ? referenceMatch[1] : null,
    };
  }

  // "Food Panda-Kara" → "FOODPANDAKARA": used to compare names regardless of spaces or punctuation.
  function normalizeKey(text) {
    return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // A sensible name to remember a merchant by: its first two words, leaving out numbers
  // like branch codes or phone numbers. "JAZZ PREPAID 03219852355" → "JAZZ PREPAID".
  function suggestKeyword(counterparty) {
    if (!counterparty) return "";
    const words = counterparty.toUpperCase().split(/\s+/)
      .map((w) => w.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ""))
      .filter((w) => w && !/\d/.test(w));
    return (words.length ? words.slice(0, 2) : [counterparty.toUpperCase()]).join(" ");
  }

  // The rule whose keyword appears in the merchant's name (the longest one if several do).
  function matchRule(item, rules) {
    const name = normalizeKey(item.counterparty);
    if (!name) return null;
    let best = null;
    for (const rule of rules || []) {
      const key = normalizeKey(rule.keyword);
      if (!key || rule.direction !== item.direction || !name.includes(key)) continue;
      if (!best || key.length > normalizeKey(best.keyword).length) best = rule;
    }
    return best;
  }

  // A fingerprint for one SMS, so the same message is never imported twice.
  function smsKey(message) {
    let hash = 0x811c9dc5;
    const body = message.body || "";
    for (let i = 0; i < body.length; i++) {
      hash ^= body.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${message.date}-${hash.toString(16)}`;
  }

  const api = { parseBankSms, normalizeKey, suggestKeyword, matchRule, smsKey };
  global.BankSms = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);