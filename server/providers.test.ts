import { describe, expect, it } from "vitest";
import { hideProviders } from "./_core/providers";

/** A workspace never learns which providers sit behind LeadDash Employees. */
describe("provider names never reach a workspace", () => {
  it("swaps names, links and server keys for plain words, and leaves the connector names alone", () => {
    expect(hideProviders("ElevenLabs is out of voice credits. Add credits or move up a plan at elevenlabs.io/app/subscription, and the voices come back on the next answer.")).toBe("the voice service is out of voice credits. Add credits or move up a plan, and the voices come back on the next answer.");
    expect(hideProviders("OpenAI is out of credits. Add credits at platform.openai.com/settings/organization/billing.")).toBe("the AI service is out of credits. Add credits.");
    expect(hideProviders("AssemblyAI could not transcribe it: bad audio")).toBe("the transcription service could not transcribe it: bad audio");
    expect(hideProviders("Recall.ai: bot kicked from call")).toBe("the meeting bot: bot kicked from call");
    expect(hideProviders("Voices are not set up: OPENAI_API_KEY is missing on the server.")).toBe("Voices are not set up: a server key is missing on the server.");
    expect(hideProviders("Anthropic 529: overloaded")).toBe("the AI service 529: overloaded");
    expect(hideProviders("Connect Claude and ChatGPT from My account.")).toBe("Connect Claude and ChatGPT from My account.");
    expect(hideProviders("I booked it in Zoom and Google Calendar.")).toBe("I booked it in Zoom and Google Calendar.");
  });
});
