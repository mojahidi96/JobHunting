import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import xlsx from "xlsx";
import { addContact, newUser, setup, xlsxBuffer, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });

const HEADER = ["Name", "Company", "Email", "Role", "Link", "isSend"];

describe("manual contacts", () => {
  it("adds, edits, filters and deletes without any upload", async () => {
    const u = await newUser(ctx);
    const c = await addContact(u, { Name: "Zed Zebra", Company: "Zoo", Role: "Keeper" });
    const dup = await u.post("/api/recruiters").send({ Name: "X", Company: "Y", Email: c.Email.toUpperCase(), Role: "Z" });
    expect(dup.status).toBe(409);
    expect((await u.post("/api/recruiters").send({ Name: "", Company: "Y", Email: "bad", Role: "Z" })).status).toBe(400);
    expect((await u.post("/api/recruiters").send({ Name: "A", Company: "B", Email: "a@b.co", Role: "C", Link: "javascript:alert(1)" })).status).toBe(400);

    const patched = await u.patch(`/api/recruiters/${c.id}`).send({ Role: "Head Keeper", isSend: "no" }).expect(200);
    expect(patched.body.item.Role).toBe("Head Keeper");
    expect(patched.body.item.isSend).toBe("no");
    expect(patched.body.item.deliveryStatus).toBe("pending"); // isSend is not delivery status
    expect(patched.body.item.source.type).toBe("manual");

    const list = await u.get("/api/recruiters?q=zebra").expect(200);
    expect(list.body.total).toBe(1);
    expect((await u.get("/api/recruiters?sort=Name;drop&order=asc")).status).toBe(400); // allow-listed sort fields
    await u.del(`/api/recruiters/${c.id}`).expect(200);
    expect((await u.get("/api/recruiters")).body.total).toBe(0);
  });
});

describe("import", () => {
  it("previews xlsx with validation, mapping and duplicates, then imports without sending", async () => {
    const u = await newUser(ctx);
    await addContact(u, { Email: "exists@acme.test" });
    const buf = xlsxBuffer([
      HEADER,
      ["Ann Lee", "Acme", "ann@acme.test", "Dev", "https://acme.test/j", "yes"],
      ["Bob", "Acme", "not-an-email", "Dev", null, null],
      ["Cy", "Acme", "exists@acme.test", "Dev", null, null],
      ["Dee", "Acme", "ann@acme.test", "Dev", null, null],
      [null, null, null, null, null, null],
      ["", "Acme", "e@acme.test", "Dev", null, null],
    ]);
    const prev = await u.post("/api/imports/preview").attach("file", buf, "recruiters.xlsx").expect(200);
    expect(prev.body.file).toMatchObject({ name: "recruiters.xlsx", format: "xlsx", worksheetName: "Recruiters_Email" });
    expect(prev.body.counts).toEqual({ total: 6, accepted: 1, rejected: 2, duplicates: 2, skipped: 1 });
    expect(prev.body.rows[1].errors.join()).toMatch(/malformed/);
    expect(prev.body.rows[5].errors.join()).toMatch(/Missing required field: Name/);
    expect((await u.get("/api/recruiters")).body.total).toBe(1); // preview saves nothing

    const imp = await u.post("/api/imports").attach("file", buf, "recruiters.xlsx").expect(201);
    expect(imp.body.import).toMatchObject({ originalFilename: "recruiters.xlsx", format: "xlsx", worksheetName: "Recruiters_Email" });
    expect(imp.body.import.counts.accepted).toBe(1);
    expect(imp.body.import.storageRef).toMatch(/^imports\/[a-f\d]{24}$/);
    expect(JSON.stringify(imp.body)).not.toContain(ctx.uploadDir);
    expect(JSON.stringify(imp.body)).not.toMatch(/\/Users\/|\/tmp\/|\/var\//);
    expect(ctx.mail.sent).toHaveLength(0); // upload never sends
    const list = (await u.get("/api/recruiters").expect(200)).body.items;
    expect(list.find((x: any) => x.Email === "ann@acme.test").source.type).toBe("import");
    expect((await u.get("/api/imports").expect(200)).body.items).toHaveLength(1);
  });

  it("maps differently named headers and reports missing columns", async () => {
    const u = await newUser(ctx);
    const buf = xlsxBuffer([["Full Name", "Org", "Mail", "Position"], ["Eve", "Corp", "eve@corp.test", "PM"]]);
    const noMap = await u.post("/api/imports/preview").attach("file", buf, "x.xlsx").expect(200);
    expect(noMap.body.missingRequired.sort()).toEqual(["Company", "Email", "Name", "Role"]);
    expect(noMap.body.unknownColumns).toEqual(["Full Name", "Org", "Mail", "Position"]);
    expect((await u.post("/api/imports").attach("file", buf, "x.xlsx")).status).toBe(422);

    const mapping = JSON.stringify({ Name: "Full Name", Company: "Org", Email: "Mail", Role: "Position" });
    const ok = await u.post("/api/imports").field("mapping", mapping).attach("file", buf, "x.xlsx").expect(201);
    expect(ok.body.import.counts.accepted).toBe(1);
  });

  it("imports JSON, rejects bad types and oversize files, serves a sample", async () => {
    const u = await newUser(ctx);
    const json = Buffer.from(JSON.stringify([
      { Name: "Json One", Company: "J", Email: "one@j.test", Role: "R", isSend: "no" },
      { Name: "Json Two", Company: "J", Email: "bad", Role: "R" },
    ]));
    const prev = await u.post("/api/imports/preview").attach("file", json, "c.json").expect(200);
    expect(prev.body.counts).toMatchObject({ accepted: 1, rejected: 1 });
    await u.post("/api/imports").attach("file", json, "c.json").expect(201);
    expect((await u.get("/api/recruiters")).body.items[0].isSend).toBe("no");

    expect((await u.post("/api/imports/preview").attach("file", Buffer.from("{}"), "c.json")).status).toBe(400); // not an array
    expect((await u.post("/api/imports/preview").attach("file", Buffer.from("MZ binary"), "evil.xlsx")).status).toBe(415);
    expect((await u.post("/api/imports/preview").attach("file", Buffer.from("x"), "a.exe")).status).toBe(415);
    const big = Buffer.alloc(6 * 1024 * 1024, 0x20);
    expect((await u.post("/api/imports/preview").attach("file", big, "big.json")).status).toBe(413);
    const sample = await u.get("/api/imports/sample").expect(200);
    expect(JSON.parse(sample.text)[0].Email).toBe("jane.doe@example.com");
  });
});

describe("export", () => {
  it("exports all / selected / filtered as json and xlsx, neutralising formulas, only for the owner", async () => {
    const a = await newUser(ctx);
    const b = await newUser(ctx);
    const c1 = await addContact(a, { Name: "=HYPERLINK(\"x\")", Company: "Alpha" });
    await addContact(a, { Company: "Beta" });
    await addContact(b, { Company: "OtherUsers" });

    const all = await a.get("/api/recruiters/export?format=json").expect(200);
    expect(JSON.parse(all.text)).toHaveLength(2);
    expect(all.text).not.toMatch(/OtherUsers|userId|passwordHash/);
    const sel = await a.get(`/api/recruiters/export?format=json&scope=selected&ids=${c1.id}`).expect(200);
    expect(JSON.parse(sel.text)).toHaveLength(1);
    const filt = await a.get("/api/recruiters/export?format=json&scope=filtered&q=beta").expect(200);
    expect(JSON.parse(filt.text)).toHaveLength(1);
    expect(JSON.parse(all.text)[0]).not.toHaveProperty("deliveryStatus");
    const withStatus = await a.get("/api/recruiters/export?format=json&includeStatus=true").expect(200);
    expect(JSON.parse(withStatus.text)[0].deliveryStatus).toBe("pending");

    // another user's id in scope=selected yields nothing
    const leak = await b.get(`/api/recruiters/export?format=json&scope=selected&ids=${c1.id}`).expect(200);
    expect(JSON.parse(leak.text)).toHaveLength(0);

    const x = await a.get("/api/recruiters/export?format=xlsx").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const wb = xlsx.read(x.body, { type: "buffer" });
    const rows = xlsx.utils.sheet_to_json<any>(wb.Sheets["Recruiters_Email"]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.Company === "Alpha").Name.startsWith("'=")).toBe(true);
  });
});

describe("profile photo", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  it("accepts valid images, rejects others, serves only to the owner, never exposes paths", async () => {
    const u = await newUser(ctx);
    const other = await newUser(ctx);
    expect((await u.post("/api/profile/photo").attach("photo", Buffer.from("<svg/>"), { filename: "a.png", contentType: "image/png" })).status).toBe(415);
    expect((await u.post("/api/profile/photo").attach("photo", Buffer.alloc(3 * 1024 * 1024, 1), "big.png")).status).toBe(413);
    const ok = await u.post("/api/profile/photo").attach("photo", PNG, "me.png").expect(200);
    expect(ok.body.profile.profilePhotoUrl).toMatch(/^\/api\/profile\/photo\?v=\d+$/);
    expect(JSON.stringify(ok.body)).not.toContain(ctx.uploadDir);
    const img = await u.get("/api/profile/photo").expect(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect((await other.get("/api/profile/photo")).status).toBe(404);
    const files = fs.readdirSync(path.join(ctx.uploadDir, "avatars"));
    expect(files.length).toBeGreaterThan(0);
    await u.del("/api/profile/photo").expect(200);
    expect((await u.get("/api/profile/photo")).status).toBe(404);
  });
});
