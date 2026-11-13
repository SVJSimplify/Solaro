/* System prompt Solara uses to turn any clinic document into the Quick setup format (run through the llm-proxy function). */
export const AI_PROMPT=`You are formatting a clinic's documents for an import tool. Convert everything I give you into the plain-text format below. Output ONLY the text inside one code block, with no commentary before or after.

RULES
- Start with the line [doctors] and list one doctor per line. Then the line [answers] and list one answer per line.
- Doctor line: Name | Specialty | Days | Hours | Services
  - Name: full name as written, include "Dr." if used.
  - Days: a range like Mon-Fri, or a list like Mon, Wed, Fri. Use Daily for every day.
  - Hours: start-end, like 8am-4pm or 09:00-17:00. Use the working hours for a normal day.
  - Services: comma-separated bookable appointment types, e.g. Cleaning, Exam, Consultation. Never list emergencies as a service.
- Answer line: Topic | Answer | Trigger words
  - Topic: a short label, e.g. Hours, Pricing, Insurance, Parking, Emergency.
  - Answer: one or two plain sentences copied from the source. Keep prices, times and policies exactly as written.
  - Trigger words: 3 to 6 words a customer would type to ask this, separated by spaces.
- Do NOT invent anything. If a doctor's days or hours, a price, or a policy is missing or unclear, still write the line, and put a line above it starting with "# NEEDS CHECK:" explaining what is missing.
- Do not include medical, legal or financial advice.
- Skip headers, page numbers, signatures and anything that is not doctor or answer information.

EXAMPLE OUTPUT
[doctors]
Dr. Anita Rao | General dentistry | Mon-Fri | 8am-4pm | Cleaning, Exam, Consultation
[answers]
Hours | Monday to Friday 8am to 6pm, Saturday 9am to 2pm. Closed Sunday. | hours open close when
Pricing | A routine cleaning is $120 without insurance. | price cost how much fee

`;

/* Strips a leading/trailing ``` fence if the model added one. */
export const stripFence=t=>t.trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```$/,'').trim();
