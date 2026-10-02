import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseForm } from "../src/server/request.js";
import { containsContactDetails } from "../src/shared/personal-data.js";
import { CONTACT, LEGITIMATE } from "./helpers/personal-data-cases.js";

describe("personal-data detector (shared by the server and the web form)", () => {
  it("lets ordinary titles, years and ZIP+4 codes through", () => {
    for (const text of LEGITIMATE) assert.equal(containsContactDetails(text), false, text);
  });

  it("still stops phone numbers and emails", () => {
    for (const text of CONTACT) assert.equal(containsContactDetails(text), true, text);
  });

  it("the server (parseForm) agrees, in the interests and the place fields", () => {
    const base = { place: "Newark, NJ", ageBand: "any", interests: "Severance, The Bear", titleCount: 8 };
    for (const text of LEGITIMATE) {
      assert.equal(parseForm({ ...base, interests: text }).ok, true, `interests: ${text}`);
      assert.equal(parseForm({ ...base, place: text }).ok, true, `place: ${text}`);
    }
    for (const text of CONTACT) {
      assert.equal(parseForm({ ...base, interests: `Severance ${text}` }).ok, false, `interests: ${text}`);
      assert.equal(parseForm({ ...base, place: `Newark ${text}` }).ok, false, `place: ${text}`);
    }
  });
});
