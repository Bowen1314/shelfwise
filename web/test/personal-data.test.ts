import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTACT, LEGITIMATE } from "../../test/helpers/personal-data-cases.js";
import { containsContactDetails, EMPTY_FORM, validateForm } from "../src/lib/validate";

describe("the web form uses the same personal-data detector as the server", () => {
  it("containsContactDetails lets ordinary titles, years and ZIP+4 codes through and stops contact details", () => {
    for (const text of LEGITIMATE) assert.equal(containsContactDetails(text), false, text);
    for (const text of CONTACT) assert.equal(containsContactDetails(text), true, text);
  });

  it("validateForm never blocks what the API accepts, in the interests and the place fields", () => {
    const base = { ...EMPTY_FORM, place: "Newark, NJ", interests: "Severance, The Bear", titleCount: "8" };
    for (const text of LEGITIMATE) {
      assert.deepEqual(validateForm({ ...base, interests: text }).errors, {}, `interests: ${text}`);
      assert.deepEqual(validateForm({ ...base, place: text }).errors, {}, `place: ${text}`);
    }
    for (const text of CONTACT) {
      assert.ok(validateForm({ ...base, interests: `Severance ${text}` }).errors.interests, `interests: ${text}`);
      assert.ok(validateForm({ ...base, place: `Newark ${text}` }).errors.place, `place: ${text}`);
    }
  });
});
