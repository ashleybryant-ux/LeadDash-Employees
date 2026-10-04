/**
 * Portraits for employees added after the original team sheet.
 * Kai, Imani and Zara now have photos the owner chose, in
 * client/public/avatars/<kind>.webp. This runs on deploy and takes away any
 * picture this script made for them earlier, so the chosen photo shows. A
 * photo someone uploaded on the Team screen is kept.
 *   npx tsx deploy/portraits.ts
 */
import "dotenv/config";
import * as db from "../server/db";

const BUNDLED = ["developer", "onboarding", "platform"] as const;

(async () => {
  let cleared = 0;
  for (const orgId of await db.listAllOrganizationIds()) {
    for (const kind of BUNDLED) {
      const emp = await db.getEmployeeByKind(orgId, kind);
      // Pictures this script generated were stored under roster/.
      if (emp?.avatar && /\/roster\//.test(emp.avatar)) {
        await db.updateEmployee(emp.id, orgId, { avatar: null });
        cleared++;
      }
    }
  }
  console.log(`portraits: Kai, Imani and Zara use their chosen photos${cleared ? ` (replaced ${cleared} generated picture${cleared === 1 ? "" : "s"})` : ""}`);
})();
