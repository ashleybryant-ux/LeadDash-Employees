import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerOAuth } from "./integrations";

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  const app = express();
  registerOAuth(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("sign-in links", () => {
  it("Add calendar reaches the Google calendar sign-in instead of 'Unknown connection.'", async () => {
    const res = await fetch(`${base}/api/oauth/link/start?organizationId=1&purpose=calendar&name=Legacy`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
    const bad = await fetch(`${base}/api/oauth/nope/start?organizationId=1`, { redirect: "manual" });
    expect(bad.status).toBe(404);
  });
});
