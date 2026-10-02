/** Ordinary readers' advisory input that merely contains digits. The detector must let all of these through. */
export const LEGITIMATE = [
  "1984, 2001: A Space Odyssey",
  "Fahrenheit 451, 1984 2001",
  "Newark, NJ 07102-1234",
  // near neighbours of the above, to catch a regression to "any long run of digits"
  "Fahrenheit 451 1984 2001",
  "1984 2001 2010 2061",
  "Catch-22, 1984, 2001",
  "Newark, NJ 07102",
  "12 Years a Slave 2013 2014",
  "Apollo 13 1995",
  "1984-2001",
  "Ages 12-14, grade 7",
];

/** Contact details in the formats the form must still stop. */
export const CONTACT = ["(973) 555-0100", "+1 (973) 555-0100", "973 - 555 - 0100", "973-555-0100", "9735550100", "+44 20 7946 0958", "pat@example.com"];
