import { describe, expect, it } from "vitest";
import { aboutPage, privacyPage, termsPage } from "./public-pages";

describe("public pages", () => {
  it("About names the app, says what it does, explains the Google access and links the privacy policy", () => {
    const html = aboutPage();
    expect(html).toContain("LeadDash Employees");
    expect(html).toContain("gmail.send");
    expect(html).toContain("calendar.events");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
  });

  it("Privacy carries Google's Limited Use statement", () => {
    expect(privacyPage()).toContain("will adhere to the <a href=\"https://developers.google.com/terms/api-services-user-data-policy\">Google API Services User Data Policy</a>, including the Limited Use requirements");
  });

  it("Terms name the company and Oklahoma law", () => {
    const html = termsPage();
    expect(html).toContain("LeadDash Marketing LLC");
    expect(html).toContain("State of Oklahoma");
  });
});
