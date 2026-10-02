/**
 * Safe-use rule: patron contact details never go to Qloo or the model. The server enforces this for every request
 * and the web form uses the same function so the browser and the API can never disagree.
 *
 * It looks for email addresses and phone-number SHAPES, not "any long run of digits". Readers' advisory input is full
 * of years and numerals (1984, 2001: A Space Odyssey, Fahrenheit 451, a ZIP+4 such as 07102-1234), and wrongly
 * rejecting those is worse than missing an exotic phone format: the form already tells staff not to enter contact
 * details.
 */

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const PHONE = new RegExp(
  [
    String.raw`\+\d{1,3}(?:[\s.()-]*\d){7,}`, // international: +CC then at least 7 more digits
    String.raw`(?<!\d)(?:1[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)`, // North American 10-digit
    String.raw`(?<!\d)\d{3}[.-]\d{4}(?!\d)`, // 7-digit local number with a hyphen or dot
  ].join("|"),
);

/** True when the text holds an email address or a phone number. */
export function containsContactDetails(text: string): boolean {
  return EMAIL.test(text) || PHONE.test(text);
}
