import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

const said: { decision: Record<string, unknown> } = { decision: {} };
const blank = { thinking: "", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [], remember_topic: "", remember_fact: "", remember_category: "", reply: "" };

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return { ...blank, ...said.decision };
      if (opts.schemaName === "role_from_chat") {
        const paid = /\$18 to \$20/.test(opts.prompt);
        return {
          title: "Front desk coordinator (part time)",
          employment: "w2",
          hours: "part",
          place: "in_person",
          hoursPerWeek: paid ? 20 : 0,
          payFrom: paid ? "$18 an hour" : "",
          payTo: paid ? "$20 an hour" : "",
          mustHave: "1 year front desk or scheduling experience",
          niceToHave: "Spanish",
          ask: paid ? "" : "How many hours a week, and what's the pay?",
          choices: paid ? [] : ["20 hours, $18 to $20", "25 hours, $18 to $22"],
        };
      }
      if (opts.schemaName === "job_description")
        return {
          about: "Bright Path is a group practice in Denver — we see families.",
          schedule: "20 hours a week, $18 to $20 an hour",
          duties: ["Greet clients and answer calls", "Schedule sessions", "Verify insurance"],
          mustHave: "1 year front desk or scheduling experience",
          niceToHave: "Spanish",
          howToApply: "Apply on the job page",
        };
      if (opts.schemaName === "screen") return { name: "Casey Morgan", credentials: "", email: "casey@resume.example", location: "Denver, CO", currentRole: "Receptionist", fitScore: 82, fitReason: "Two years at a busy front desk.", mustHaves: [] };
      return {};
    }),
    generateText: vi.fn(async () => "ok"),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { ENV } from "./_core/env";
import { registerCareers, jobPostingLd, indeedXml, sitemapXml, parseMultipart } from "./careers";
import * as jobs from "./employees/jobs";

let base = "";
let server: ReturnType<express.Express["listen"]>;
beforeAll(() => {
  const app = express();
  registerCareers(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.unstubAllGlobals());

async function workspace(slug: string, place = "Denver, CO") {
  const w = await makeWorkspace(slug);
  await db.updateOrganization(w.orgId, { state: place, website: "brightpath.example", name: `Bright Path ${slug}` });
  return w;
}

async function role(orgId: number, title: string, extra: Record<string, unknown> = {}) {
  return db.createHrRole({ organizationId: orgId, title, hours: "part", place: "in_person", payFrom: "$18 an hour", payTo: "$20 an hour", mustHave: "Front desk experience", ...extra });
}

describe("Quinn writes the job description from chat", () => {
  it("adds the role, asks only for hours and pay with choices, writes the description, then posts it", async () => {
    const { orgId, owner } = await workspace("jd-chat");
    const quinn = (await db.getEmployeeByKind(orgId, "hiring"))!;
    const c = caller(owner);

    said.decision = { action: "write_job_post", target: "Front desk", notes: "part-time" };
    const first = await c.chat.send({ organizationId: orgId, employeeId: quinn.id, text: "We need a part-time front desk person" });
    expect(first.reply.content).toBe("How many hours a week, and what's the pay?");
    const options = JSON.parse(first.reply.cards!).find((x: any) => x.type === "choices").options;
    expect(options).toEqual(["20 hours, $18 to $20", "25 hours, $18 to $22", "I'll type it"]);
    const added = (await db.listHrRoles(orgId))[0];
    expect(added.title).toBe("Front desk coordinator (part time)");
    expect(jobs.readJd(added)?.duties ?? "").toBe(""); // not written until the pay is known

    said.decision = { action: "write_job_post", target: "Front desk coordinator", notes: "20 hours, $18 to $20" };
    const second = await c.chat.send({ organizationId: orgId, employeeId: quinn.id, text: "20 hours, $18 to $20" });
    expect(second.reply.content).toMatch(/^Here's the job description/);
    expect(JSON.parse(second.reply.cards!).find((x: any) => x.type === "choices").options).toEqual(["Post it", "Change it"]);
    const roles = await db.listHrRoles(orgId);
    expect(roles).toHaveLength(1); // the same role, not a second one
    const r = roles[0];
    expect(r.payFrom).toBe("$18 an hour");
    const jd = jobs.readJd(r)!;
    expect(jd.schedule).toBe("20 hours a week, $18 to $20 an hour");
    expect(jd.hoursPerWeek).toBe(20);
    expect(jd.about).not.toMatch(/[—–]/);
    expect(r.post).toContain("What you'll do\n- Greet clients and answer calls");

    said.decision = { action: "publish_job", target: "Front desk" };
    const third = await c.chat.send({ organizationId: orgId, employeeId: quinn.id, text: "Post it" });
    expect(third.reply.content).toContain("is live");
    expect((await db.getHrRole(r.id, orgId))!.publishedAt).toBeTruthy();
  });
});

describe("publishing", () => {
  it("sets the job live and builds Google's JobPosting markup with the required fields", async () => {
    const { orgId, owner } = await workspace("jd-pub");
    const r = await role(orgId, "Front desk coordinator (part time)");
    const view = await caller(owner).hiring.publish({ organizationId: orgId, id: r.id });
    expect(Object.keys(view).sort()).toEqual(["applicants", "jobUrl", "live", "liveSince"]);
    expect(view.live).toBe(true);
    expect(view.jobUrl).toBe(`${ENV.appUrl}/careers/jd-pub/front-desk-coordinator`);

    const org = (await db.getOrganizationById(orgId))!;
    const saved = (await db.getHrRole(r.id, orgId))!;
    const ld = jobPostingLd(org, saved) as any;
    expect(ld["@type"]).toBe("JobPosting");
    expect(ld.title).toBe("Front desk coordinator (part time)");
    expect(ld.description).toContain("<li>Greet clients and answer calls</li>");
    expect(ld.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ld.employmentType).toBe("PART_TIME");
    expect(ld.hiringOrganization).toEqual({ "@type": "Organization", name: "Bright Path jd-pub", sameAs: "https://brightpath.example" });
    expect(ld.jobLocation.address).toMatchObject({ addressLocality: "Denver", addressRegion: "CO", addressCountry: "US" });
    expect(ld.baseSalary.value).toMatchObject({ minValue: 18, maxValue: 20, unitText: "HOUR" });
    expect(ld.directApply).toBe(true);

    const tele = await role(orgId, "Telehealth therapist", { place: "telehealth", hours: "full", payFrom: "$60,000", payTo: "$72,000" });
    await jobs.publish(orgId, tele.id);
    const t = jobPostingLd(org, (await db.getHrRole(tele.id, orgId))!) as any;
    expect(t.jobLocationType).toBe("TELECOMMUTE");
    expect(t.jobLocation).toBeUndefined();
    expect(t.baseSalary.value).toMatchObject({ minValue: 60000, maxValue: 72000, unitText: "YEAR" });

    const page = await (await fetch(`${base}/careers/jd-pub/front-desk-coordinator`)).text();
    expect(page).toContain('<script type="application/ld+json">');
    expect(page).toContain('name="resume" type="file"');
    expect(page).not.toContain("noindex");

    const off = await caller(owner).hiring.unpublish({ organizationId: orgId, id: r.id });
    expect(off.live).toBe(false);
    expect((await fetch(`${base}/careers/jd-pub/front-desk-coordinator`)).status).toBe(404);
  });
});

describe("the careers page and applying", () => {
  it("lists only this workspace's published roles", async () => {
    const a = await workspace("cp-a");
    const b = await workspace("cp-b");
    const live = await role(a.orgId, "Therapist");
    await role(a.orgId, "Billing specialist"); // not published
    const other = await role(b.orgId, "Office manager");
    await jobs.publish(a.orgId, live.id);
    await jobs.publish(b.orgId, other.id);
    const html = await (await fetch(`${base}/careers/cp-a`)).text();
    expect(html).toContain("Careers at Bright Path cp-a");
    expect(html).toContain("Therapist");
    expect(html).not.toContain("Billing specialist");
    expect(html).not.toContain("Office manager");
  });

  it("puts an applicant in the right workspace's Candidates, scored, and drops the honeypot", async () => {
    const a = await workspace("ap-a");
    const b = await workspace("ap-b");
    const r = await role(a.orgId, "Front desk coordinator");
    await role(b.orgId, "Front desk coordinator");
    await jobs.publish(a.orgId, r.id);
    const url = `${base}/careers/ap-a/front-desk-coordinator/apply`;
    const form = (extra: Record<string, string> = {}) => {
      const f = new FormData();
      f.set("name", "Casey Morgan");
      f.set("email", "Casey@Example.com");
      f.set("phone", "405-555-0100");
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      f.set("resume", new Blob(["Casey Morgan. Two years at a busy front desk."], { type: "text/plain" }), "casey.txt");
      return f;
    };

    const bot = await fetch(url, { method: "POST", body: form({ website: "http://spam.example" }) });
    expect(bot.status).toBe(200);
    expect(await db.listHrPeople(a.orgId, "applicant")).toHaveLength(0);

    const res = await fetch(url, { method: "POST", body: form() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thank you");
    const people = await db.listHrPeople(a.orgId, "applicant");
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ roleId: r.id, name: "Casey Morgan", email: "casey@example.com", phone: "405-555-0100", fitScore: 82, stage: "new" });
    expect(await db.listHrPeople(b.orgId)).toHaveLength(0);
    // Applying twice doesn't make a second card.
    await fetch(url, { method: "POST", body: form() });
    expect(await db.listHrPeople(a.orgId, "applicant")).toHaveLength(1);

    const noFile = new FormData();
    noFile.set("name", "Sam");
    noFile.set("email", "sam@example.com");
    expect((await fetch(url, { method: "POST", body: noFile })).status).toBe(400);
    expect((await fetch(`${base}/careers/ap-b/front-desk-coordinator/apply`, { method: "POST", body: form() })).status).toBe(404); // not published there
  });

  it("reads a multipart body", () => {
    const body = Buffer.from('--xx\r\nContent-Disposition: form-data; name="name"\r\n\r\nCasey\r\n--xx\r\nContent-Disposition: form-data; name="resume"; filename="c.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--xx--\r\n');
    const p = parseMultipart(body, "multipart/form-data; boundary=xx")!;
    expect(p.fields.name).toBe("Casey");
    expect(p.files[0]).toMatchObject({ field: "resume", name: "c.txt", mime: "text/plain" });
    expect(p.files[0].data.toString()).toBe("hello");
  });
});

describe("the job feeds", () => {
  it("indeed.xml and the sitemap carry published jobs from every workspace and nothing unpublished", async () => {
    const a = await workspace("feed-a", "Oklahoma City, OK");
    const b = await workspace("feed-b", "Tulsa, OK");
    const ra = await role(a.orgId, "Feed therapist A");
    const rb = await role(b.orgId, "Feed counselor B");
    await role(a.orgId, "Feed hidden role");
    await jobs.publish(a.orgId, ra.id);
    await jobs.publish(b.orgId, rb.id);
    const xml = await (await fetch(`${base}/careers/indeed.xml`)).text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<source>/);
    expect(xml).toContain("<title><![CDATA[Feed therapist A]]></title>");
    expect(xml).toContain("<title><![CDATA[Feed counselor B]]></title>");
    expect(xml).not.toContain("Feed hidden role");
    expect(xml).toContain(`<referencenumber><![CDATA[ld-${a.orgId}-${ra.id}]]></referencenumber>`);
    expect(xml).toContain(`<url><![CDATA[${ENV.appUrl}/careers/feed-a/feed-therapist-a?source=Indeed]]></url>`);
    expect(xml).toContain("<city><![CDATA[Tulsa]]></city>");
    expect(xml).toContain("<salary><![CDATA[$18 - $20 per hour]]></salary>");
    expect(xml).toContain("<jobtype><![CDATA[parttime]]></jobtype>");
    expect(xml).toContain("<description><![CDATA[<p>"); // literal HTML inside CDATA
    // Every job carries every element.
    const jobsIn = xml.split("<job>").slice(1);
    for (const j of jobsIn) for (const el of ["date", "requisitionid", "company", "sourcename", "state", "country", "postalcode", "email", "education", "experience"]) expect(j).toContain(`<${el}>`);

    const map = await sitemapXml();
    expect(map).toContain(`<loc>${ENV.appUrl}/careers/feed-b/feed-counselor-b</loc>`);
    expect(map).not.toContain("feed-hidden-role");
    expect(await indeedXml()).toContain("Feed therapist A");
  });
});

describe("Frappe HR", () => {
  it("is skipped when the server has no Frappe settings", async () => {
    const { orgId } = await workspace("fr-off");
    const r = await role(orgId, "Skip frappe role");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await jobs.publish(orgId, r.id);
    expect(await jobs.pullFrappeApplicants()).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("creates the Job Opening with the token header, pulls its applicants once, and closes it on Unpublish", async () => {
    const { orgId } = await workspace("fr-on");
    const r = await role(orgId, "Frappe front desk");
    Object.assign(ENV, { frappeUrl: "https://hr.example", frappeApiKey: "k1", frappeApiSecret: "s1" });
    const calls: { method: string; url: string; auth: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ method: init?.method ?? "GET", url: decodeURIComponent(url), auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : null });
        const u = decodeURIComponent(url);
        const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("/api/resource/Company?")) return json([{ name: "Bright Path fr-on" }]);
        if (u.includes("/api/resource/Designation?")) return json([]);
        if (u.endsWith("/api/resource/Designation")) return json({ name: "Frappe front desk" });
        if (u.endsWith("/api/resource/Job Opening")) return json({ name: "HR-OPN-2026-0001" });
        if (u.includes("/api/resource/Job Opening/")) return json({ name: "HR-OPN-2026-0001" });
        if (u.includes("/api/resource/Job Applicant?")) return json([{ name: "HR-APP-1", applicant_name: "Riley Park", email_id: "riley@example.com", phone_number: "555-0101", resume_attachment: null, resume_link: null, cover_letter: "Front desk for 3 years.", job_title: "HR-OPN-2026-0001" }]);
        return new Response("{}", { status: 404 });
      })
    );
    try {
      await jobs.publish(orgId, r.id);
      expect(calls.every((c) => c.auth === "token k1:s1")).toBe(true);
      expect(calls.map((c) => `${c.method} ${c.url.split("?")[0].replace("https://hr.example", "")}`)).toEqual(["GET /api/resource/Company", "GET /api/resource/Designation", "POST /api/resource/Designation", "POST /api/resource/Job Opening"]);
      expect(calls[3].body).toMatchObject({ job_title: "Frappe front desk", company: "Bright Path fr-on", designation: "Frappe front desk", status: "Open", employment_type: "Part-time" });
      expect(JSON.parse((await db.getHrRole(r.id, orgId))!.channels!)).toEqual({ frappe: "HR-OPN-2026-0001" });

      expect(await jobs.pullFrappeApplicants()).toBe(1);
      expect(calls.at(-1)!.url).toContain('[["job_title","in",["HR-OPN-2026-0001"]]]');
      const people = await db.listHrPeople(orgId, "applicant");
      expect(people).toHaveLength(1);
      expect(people[0]).toMatchObject({ roleId: r.id, name: "Riley Park", email: "riley@example.com", phone: "555-0101" });
      expect(await jobs.pullFrappeApplicants()).toBe(0); // the same email and role come in once

      calls.length = 0;
      await jobs.unpublish(orgId, r.id);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "PUT", url: "https://hr.example/api/resource/Job Opening/HR-OPN-2026-0001", body: { status: "Closed" } });
    } finally {
      Object.assign(ENV, { frappeUrl: "", frappeApiKey: "", frappeApiSecret: "" });
    }
  });

  it("a channel that fails never blocks publishing", async () => {
    const { orgId } = await workspace("fr-fail");
    const r = await role(orgId, "Fails role");
    Object.assign(ENV, { frappeUrl: "https://hr.example", frappeApiKey: "k1", frappeApiSecret: "s1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const v = await jobs.publish(orgId, r.id);
      expect(v.live).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("s1");
    } finally {
      warn.mockRestore();
      Object.assign(ENV, { frappeUrl: "", frappeApiKey: "", frappeApiSecret: "" });
    }
  });
});

describe("what the screen gets", () => {
  it("never carries channel names or ids", async () => {
    const { orgId, owner } = await workspace("payload");
    const r = await role(orgId, "Payload role");
    await db.updateHrRole(r.id, orgId, { channels: JSON.stringify({ frappe: "HR-OPN-9" }), targets: JSON.stringify([{ name: "Indeed", status: "ready", url: null }]) });
    await jobs.publish(orgId, r.id);
    const c = caller(owner);
    const roles = await c.hiring.roles({ organizationId: orgId });
    const text = JSON.stringify(roles);
    for (const word of ["frappe", "HR-OPN", "Indeed", "channels", "targets", "LinkedIn"]) expect(text).not.toContain(word);
    expect(Object.keys(roles[0].job).sort()).toEqual(["applicants", "jobUrl", "live", "liveSince"]);
    expect(roles[0].job.live).toBe(true);
    const saved = await c.hiring.saveRole({ organizationId: orgId, id: r.id, title: "Payload role", employment: "w2", hours: "part", place: "both", payFrom: "", payTo: "", licenses: [], mustHave: "", niceToHave: "" });
    expect(JSON.stringify(saved)).not.toContain("HR-OPN");
  });
});
