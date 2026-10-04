import * as db from "../db";
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "../../drizzle/schema";
import { indexKnowledge } from "./kb";

/**
 * What employees learn in conversation. When the owner says something new and
 * lasting (a new offer, a price change, who the customer is, a person on the team),
 * the employee saves it to the Brain as "Learned: <topic>", so every employee
 * knows it from then on and nobody asks again. Saying the same topic again
 * replaces the old line (prices change). Entries can be edited or deleted on the
 * Brain page.
 */

export const LEARNED = "Learned: ";

/** Never kept: client names or health details, passwords and codes. */
function unsafe(text: string) {
  return /\b(password|passcode|pin code|sign-?in code|verification code|ssn|social security|diagnos\w*|medications?|dob|date of birth)\b/i.test(text);
}

export async function learnFact(orgId: number, input: { topic: string; fact: string; category?: string; who: string; via: string; when?: string }) {
  const topic = input.topic.replace(/\s+/g, " ").trim().slice(0, 80);
  const fact = input.fact.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim().slice(0, 1000);
  if (!topic || !fact || unsafe(`${topic} ${fact}`)) return null;
  const category = ((KNOWLEDGE_CATEGORIES as readonly string[]).includes(input.category ?? "") ? input.category : "mission_profile") as KnowledgeCategory;
  const org = await db.getOrganizationById(orgId);
  const day = input.when ?? new Date().toLocaleDateString("en-US", { timeZone: org?.timezone || "America/Chicago", month: "short", day: "numeric", year: "numeric" });
  const content = `${fact}\n(${input.who} told ${input.via} on ${day}.)`;
  const title = `${LEARNED}${topic}`;
  const have = (await db.listKnowledgeByOrg(orgId)).find((k) => k.employeeId == null && k.title.toLowerCase() === title.toLowerCase());
  const item = have ? await db.updateKnowledgeItem(have.id, orgId, { content, category, kind: "fact" }) : await db.createKnowledgeItem({ organizationId: orgId, title, category, kind: "fact", content });
  if (item) indexKnowledge(item);
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: input.via, action: have ? "Updated the Brain" : "Added to the Brain", details: title });
  return item ? { item, replaced: !!have, fact } : null;
}
