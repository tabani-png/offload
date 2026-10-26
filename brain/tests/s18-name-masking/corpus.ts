// s18 corpora. NAME_CASES: texts as they appear on screen, in OCR, in a CV, a ticket, a row or an email, with the
// person names that must be masked (`names`) and the words that must survive (`keep`). Grouped by the five s12
// personas plus founder outreach and a general set of harder cases (names outside the lexicons, cue-only names).
// NON_NAMES: lines with no person name at all (UI labels, months, products, companies, job titles, headings); any
// change the masker makes to one of them is a false positive.

export interface NameCase {
  persona: "recruiter" | "bookkeeper" | "support" | "salesops" | "founder" | "general";
  text: string;
  names: string[];
  keep?: string[];
}

export const NAME_CASES: NameCase[] = [
  // ---------- recruiter: CVs, Greenhouse, cover letters ----------
  { persona: "recruiter", text: "CV - Amara Okafor.pdf", names: ["Amara Okafor"], keep: ["CV"] },
  { persona: "recruiter", text: "Amara Okafor\nExperience\nStripe 2021-2025\nSkills: Go, Postgres", names: ["Amara Okafor"], keep: ["Experience", "Stripe", "Skills", "Postgres"] },
  { persona: "recruiter", text: "Amara Okafor - Senior Backend Engineer - Greenhouse", names: ["Amara Okafor"], keep: ["Senior Backend Engineer", "Greenhouse"] },
  { persona: "recruiter", text: "Ivan Petrov\nApplication: Product Designer\nResume: CV - Ivan Petrov.pdf\nScorecard  Move stage", names: ["Ivan Petrov"], keep: ["Product Designer", "Scorecard", "Move stage"] },
  { persona: "recruiter", text: "Dear Ms Novak,\n\nThank you for applying for the Data Analyst role at Talentry.", names: ["Novak"], keep: ["Data Analyst", "Talentry", "Thank you"] },
  { persona: "recruiter", text: "Candidate: Wen Tanaka\nStage: Phone screen\nRecruiter: Jo Park", names: ["Wen Tanaka", "Jo Park"], keep: ["Phone screen"] },
  { persona: "recruiter", text: "References available: Dr. Helen Fischer (Lindqvist Consulting), Mr Tomasz Kowalski", names: ["Helen Fischer", "Tomasz Kowalski"], keep: ["Lindqvist Consulting"] },
  { persona: "recruiter", text: "My name is Siobhan Kowalczyk and I am applying for the Account Executive opening.", names: ["Siobhan Kowalczyk"], keep: ["Account Executive"] },
  { persona: "recruiter", text: "Hi Mateo,\nThanks for your time today. Next step is a call with Priya on Thursday.\nBest,\nJo", names: ["Mateo", "Priya", "Jo"], keep: ["Thursday"] },
  { persona: "recruiter", text: "Keiko Nakamura's portfolio shows strong research skills.", names: ["Keiko Nakamura"] },
  { persona: "recruiter", text: "Reviewing a CV for Zane Moreau against the Senior Backend Engineer spec", names: ["Zane Moreau"], keep: ["Senior Backend Engineer"] },
  { persona: "recruiter", text: "Interviewer: Bilal Haddad | Interviewee: Elif Kaya", names: ["Bilal Haddad", "Elif Kaya"] },
  // ---------- bookkeeper: invoices with contact names ----------
  { persona: "bookkeeper", text: "Acme Office Supply\nInvoice INV-12345\nAmount due 423.10\nContact: Maria Gonzalez", names: ["Maria Gonzalez"], keep: ["Acme Office Supply", "Invoice", "Amount due"] },
  { persona: "bookkeeper", text: "From: Brightline Couriers <accounts@brightline.com>\nAttn: Peter Mensah", names: ["Peter Mensah"], keep: ["Brightline Couriers", "accounts@brightline.com"] },
  { persona: "bookkeeper", text: "Please remit to Metro Cleaning Co, attention Olga Petrov, Accounts Receivable", names: ["Olga Petrov"], keep: ["Metro Cleaning Co", "Accounts Receivable"] },
  { persona: "bookkeeper", text: "Approved by Tariq Haddad on behalf of Delta Packaging", names: ["Tariq Haddad"], keep: ["Delta Packaging"] },
  { persona: "bookkeeper", text: "New Bill\nFrom Evergreen Utilities\nReference INV-55120\nTotal 88.00\nRequested by: Hana Silva", names: ["Hana Silva"], keep: ["New Bill", "Evergreen Utilities", "Reference"] },
  { persona: "bookkeeper", text: "Questions about this invoice? Email goran.varga@falconit.com or call Goran on 020 7946 0000.", names: ["goran.varga", "Goran"], keep: ["falconit.com"] },
  { persona: "bookkeeper", text: "Gold Coast Catering - Statement for September - prepared by Nia Osei", names: ["Nia Osei"], keep: ["Gold Coast Catering", "Statement", "September"] },
  { persona: "bookkeeper", text: "Bank reconciliation in Xero: payment from Hilltop Print matched by Sven Lindqvist", names: ["Sven Lindqvist"], keep: ["Xero", "Hilltop Print"] },
  // ---------- support: tickets ----------
  { persona: "support", text: "Where is my order?\nCustomer: Hi, my order has not arrived (order #48213)\n\nThanks,\nRosa Silva", names: ["Rosa Silva"], keep: ["Customer", "Thanks"] },
  { persona: "support", text: "Ticket #48213 from Jonas Fischer: refund request", names: ["Jonas Fischer"], keep: ["Ticket"] },
  { persona: "support", text: "Hi Keiko,\n\nThanks for getting in touch. I have checked order #1042 and it ships today.\n\nBest,\nSam", names: ["Keiko", "Sam"], keep: ["Thanks"] },
  { persona: "support", text: "Requester: viktor.varga@gmail.com\nAssignee: Lea\nPriority: Normal", names: ["viktor.varga", "Lea"], keep: ["Priority", "Normal"] },
  { persona: "support", text: "Internal note: Raj says Mrs Dubois called twice about the return label.", names: ["Raj", "Dubois"], keep: ["Internal note", "return label"] },
  { persona: "support", text: "Yara Reyes (yara.reyes@outlook.com) wrote: the shirt is too small", names: ["Yara Reyes", "yara.reyes"], keep: ["outlook.com"] },
  { persona: "support", text: "Assigned to Quinn Larsen - Zendesk Support", names: ["Quinn Larsen"], keep: ["Zendesk Support"] },
  { persona: "support", text: "Kind regards,\nFarah\nCustomer Care, Lumen Retail", names: ["Farah"], keep: ["Customer Care", "Lumen Retail"] },
  // ---------- sales ops: rows ----------
  { persona: "salesops", text: "Uma Reyes, VP Sales, Bluefin Analytics, linkedin.com/in/uma-reyes", names: ["Uma Reyes", "uma-reyes"], keep: ["VP Sales", "Bluefin Analytics"] },
  { persona: "salesops", text: "Name: Goran Dubois | Title: Head of Operations | Company: Orbit Payments", names: ["Goran Dubois"], keep: ["Head of Operations", "Orbit Payments"] },
  { persona: "salesops", text: "Bilal Kaya\tCTO\tVela Robotics\tbilal.kaya@velarobotics.ai", names: ["Bilal Kaya", "bilal.kaya"], keep: ["CTO", "Vela Robotics", "velarobotics.ai"] },
  { persona: "salesops", text: "Dara Mensah - Head of Finance - Cedar Health | LinkedIn", names: ["Dara Mensah"], keep: ["Head of Finance", "Cedar Health", "LinkedIn"] },
  { persona: "salesops", text: "Lead owner: Chen Rossi; Account: Quarry Software; Status: Qualified", names: ["Chen Rossi"], keep: ["Quarry Software", "Qualified"] },
  { persona: "salesops", text: "Viktor Ibrahim, Director of Operations at Tidewater Foods", names: ["Viktor Ibrahim"], keep: ["Director of Operations", "Tidewater Foods"] },
  { persona: "salesops", text: "Enriched: Lena Novak, COO, Granite Insurance, lena@graniteins.com", names: ["Lena Novak", "lena"], keep: ["COO", "Granite Insurance", "graniteins.com"] },
  { persona: "salesops", text: "Meeting booked with Omar Tanaka (Pinecone Travel) for next Tuesday", names: ["Omar Tanaka"], keep: ["Pinecone Travel", "Tuesday"] },
  // ---------- founder outreach (gen.ts, sent-mail.ts) ----------
  { persona: "founder", text: "Hi Anna,\n\nOffload is a Mac app that watches a week of your work and automates the parts that repeat.\n\nWorth 20 minutes next week?\n\nMuhammad", names: ["Anna", "Muhammad"], keep: ["Offload", "Mac"] },
  { persona: "founder", text: "James Chen <james.chen@accel.com>\nThanks Muhammad, happy to find a time.", names: ["James Chen", "james.chen", "Muhammad"], keep: ["accel.com"] },
  { persona: "founder", text: "Sofia Rossi  Re: Offload seed round: Creandum  Thanks Muhammad, send the deck", names: ["Sofia Rossi", "Muhammad"], keep: ["Offload", "Creandum"] },
  { persona: "founder", text: "--\nMuhammad Ali\nFounder, Offload\n+44 7700 900123 | offload.so", names: ["Muhammad Ali"], keep: ["Founder", "Offload"] },
  { persona: "founder", text: "Hi Nina,\n\nRaising a $2.5M seed. 40 design partners, 3 paying.\n\nOpen to a short call? Deck attached.\n\nMuhammad", names: ["Nina", "Muhammad"] },
  { persona: "founder", text: "To: sam.okafor@plural.vc\nSubject: Offload seed round: Plural\n\nHi Sam,", names: ["sam.okafor", "Sam"], keep: ["Plural", "Subject"] },
  { persona: "founder", text: "Kofi Larsen  Re: Offload <> Northzone  Thanks Muhammad, looping in my partner", names: ["Kofi Larsen", "Muhammad"], keep: ["Northzone"] },
  { persona: "founder", text: "Rachel replied: passing for now. Follow up with Marc and Clara next week.", names: ["Rachel", "Marc", "Clara"] },
  // ---------- general: harder cases ----------
  { persona: "general", text: "Dear Xochitl,\nWe received your application.", names: ["Xochitl"] },
  { persona: "general", text: "Hello Oluwaseun, thanks for the update.", names: ["Oluwaseun"] },
  { persona: "general", text: "Prof. Aditi Raghunathan will join the panel.", names: ["Aditi Raghunathan"] },
  { persona: "general", text: "Signed: Bartholomew Quist", names: ["Bartholomew Quist"] },
  { persona: "general", text: "Ludovica van der Berg and Jean-Luc Moreau signed the contract.", names: ["Ludovica van der Berg", "Jean-Luc Moreau"] },
  { persona: "general", text: "Call with Ngozi Adeyemi re: renewal", names: ["Ngozi Adeyemi"] },
  { persona: "general", text: "Mr O'Brien asked for the March statement.", names: ["O'Brien"], keep: ["March"] },
  { persona: "general", text: "Thanks, Bjorn", names: ["Bjorn"] },
  { persona: "general", text: "Cheers,\nTomoko", names: ["Tomoko"] },
  { persona: "general", text: "Contact person: Wanjiru Kamau", names: ["Wanjiru Kamau"] },
  { persona: "general", text: "Applicant: Fionnuala Ni Bhriain", names: ["Fionnuala Ni Bhriain"] },
  { persona: "general", text: "Approved by Krzysztof Wiśniewski", names: ["Krzysztof Wiśniewski"] },
  { persona: "general", text: "Meeting notes from Tuesday: Zhang Wei will send the deck.", names: ["Zhang Wei"], keep: ["Tuesday"] },
  { persona: "general", text: "Ask Thandiwe about the onboarding checklist.", names: ["Thandiwe"] },
  { persona: "general", text: "Will Smith and May Chen joined the call.", names: ["Will Smith", "May Chen"] },
];

/** Lines with no person name. Any change is a false positive. */
export const NON_NAMES: string[] = [
  // UI labels and buttons
  "New Bill | Xero", "Move Stage", "Scorecard  Move stage", "Save Draft", "Mark as Read", "Mark Complete", "Reply All",
  "Forward", "Archive", "Inbox (12) - Gmail", "Google Calendar - Week", "Zoom Meeting", "Participants (4)",
  "Mute  Stop Video  Share Screen", "Bill To", "Ship To", "Apply Macro", "Submit as Solved", "Internal Note",
  "Public Reply", "Sign In", "Sign Up", "Log Out", "Settings", "Help Center", "Release Notes", "Pull Request",
  "Merge Branch", "Code Review", "Open in Google Sheets", "Add to Calendar", "Track Package", "Refund Request",
  "Return Label", "Order Status: Shipped", "Lead Status: Qualified", "View in Browser", "Unsubscribe",
  "Privacy Policy", "Terms of Service", "Sent from my iPhone", "Get Outlook for iOS", "Grace Period",
  "Rose Gold", "Will Call", "Hope Street Office", "Dark Mode", "Unit Price", "List Price", "Total Amount Due",
  "Thank You For Your Business", "Download PDF", "Export CSV", "Upload Files", "Select All", "Show More",
  // headings
  "Experience", "Skills", "Education", "Work History", "Summary", "Contact Details", "References available on request",
  "Professional Experience", "Key Achievements", "Cover Letter", "Job Description", "Requirements", "Responsibilities",
  // greetings without names
  "Hi there", "Hi team", "Hello World", "Dear Customer", "Dear Hiring Manager", "Dear Sir or Madam", "Thanks Team",
  "Best Regards", "Kind Regards", "Hi all,", "Hello everyone", "Hey folks", "Thanks,\nThe Support Team",
  "Best,\nCustomer Care", "Cheers,\nOffload", "Regards,\nAccounts Payable",
  // months, days, dates
  "Invoice due May 30", "June Report", "Q3 Planning - August", "Monday Standup", "Tuesday or Wednesday", "Due Friday",
  "April Showers Sale", "March Madness", "Christmas Party", "Sunday Brunch", "Week of October 12",
  // job titles
  "Senior Backend Engineer", "Product Designer", "Data Analyst", "Account Executive", "Head of Operations",
  "Customer Success Manager", "VP Sales", "Chief Financial Officer", "Hiring Manager", "Talent Acquisition Partner",
  "Accounts Payable Clerk", "Support Agent", "Operations Lead",
  // companies
  "Northwind Logistics", "Bluefin Analytics", "Cedar Health", "Harbor Freight Labs", "Lumen Retail",
  "Quarry Software", "Tidewater Foods", "Orbit Payments", "Granite Insurance", "Vela Robotics", "Summit Legal",
  "Pinecone Travel", "Acme Office Supply", "Brightline Couriers", "Metro Cleaning Co", "Delta Packaging",
  "Evergreen Utilities", "Falcon IT Services", "Gold Coast Catering", "Hilltop Print", "Morgan Stanley",
  "Goldman Sachs", "Wells Fargo", "Talentry", "Northzone", "Creandum", "Speedinvest", "Cherry Ventures",
  "Point Nine", "Felix Capital", "Plural", "Balderton", "Sequoia Capital", "Andreessen Horowitz",
  // products and apps
  "Visual Studio Code", "Microsoft Teams", "Apple Mail", "Google Chrome", "Adobe Acrobat", "Notion", "Linear", "Jira",
  "Confluence", "HubSpot", "Salesforce", "Shopify Admin", "Zendesk Support", "Intercom", "Greenhouse", "Lever",
  "Workday", "QuickBooks Online", "Stripe Dashboard", "Slack", "Google Docs", "Preview", "Finder", "Terminal",
  "Amazon Web Services", "LinkedIn Sales Navigator", "Gmail - Compose", "Mail Merge",
  // titles and sentences from the fixtures
  "#general (Channel) - Talentry - Slack", "Standup moved to 2pm", "New Hire Starts Monday",
  "Reminder: timesheets due friday", "Markets steady as rates hold | The Guardian",
  "Retail sales rise in September - BBC News", "Show HN: a tiny database | Hacker News",
  "Offload seed round: Northzone", "Deck attached.", "Worth 20 minutes next week?",
  "Offload is a Mac app that watches a week of your work and automates the parts that repeat.",
  "We are raising a $2.5M seed. Traction: 40 design partners, 3 paying.", "Where is my order?",
  "Customer: Hi, my order has not arrived (order #48213)", "Looking up the customer's order in Shopify",
  "Keying a supplier bill into Xero", "Reading a candidate CV against the job spec",
  "Writing a scorecard and moving the candidate to the next stage in Greenhouse",
  "Enriching lead rows from LinkedIn", "Bank reconciliation in Xero", "Answering support tickets with macros",
  "Screening CVs into Greenhouse", "Copying invoice details into the Xero bill form", "Preview PDF viewer",
  "Greenhouse candidate page", "Xero new bill form", "Zendesk ticket view", "Google Sheets lead list",
  "Skills: Go, Postgres", "Stripe 2021-2025", "Application: Product Designer", "Amount due 423.10",
  "Due in 30 days", "Participants (4)", "Profit and Loss", "Balance Sheet", "Purchase Order", "Sales Pipeline",
  "Accounts Receivable", "Cash Flow Statement", "Quarterly Business Review", "Net Promoter Score",
];
