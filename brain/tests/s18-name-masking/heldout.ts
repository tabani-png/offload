// s18 held-out names (review wave B, PR #7 item 3). People whose names are in none of the embedded lexicons
// (privacy/lexicon.ts GIVEN, FAMILY, AMBIGUOUS_GIVEN) and that appear with no cue: no greeting, honorific, role or weak
// cue before them and no closing line above them. The masker was not tuned on this set and must never be: it measures
// how much of real mail the rules miss, which the tuned corpus (corpus.ts) cannot. Reported apart from that corpus.

export interface HeldOutCase {
  text: string;
  names: string[];
}

export const HELD_OUT: HeldOutCase[] = [
  { text: "CV - Njeri Wambugu.pdf", names: ["Njeri Wambugu"] },
  { text: "Bongani Dlamini - Senior Analyst - Greenhouse", names: ["Bongani Dlamini"] },
  { text: "Aroha Ngata left a comment on the Q3 plan", names: ["Aroha Ngata"] },
  { text: "Portfolio review: Tavita Faleolo.pdf", names: ["Tavita Faleolo"] },
  { text: "Ikaika Kealoha accepted the invite", names: ["Ikaika Kealoha"] },
  { text: "Offer letter - Zhanna Abdrakhmanova - draft 2", names: ["Zhanna Abdrakhmanova"] },
  { text: "Esi Ansah, Account Manager, Northwind", names: ["Esi Ansah"] },
  { text: "Chidinma Eze shared a folder", names: ["Chidinma Eze"] },
  { text: "Expense claim submitted - Tendai Moyo - 3 receipts", names: ["Tendai Moyo"] },
  { text: "Nalani Kahale joined the channel", names: ["Nalani Kahale"] },
  { text: "Thandeka Zulu is out of office until Monday", names: ["Thandeka Zulu"] },
  { text: "Yerlan Nurlanov updated the status to Done", names: ["Yerlan Nurlanov"] },
  { text: "Mahlet Tesfaye - Cover letter.docx", names: ["Mahlet Tesfaye"] },
  { text: "Abebe Bekele commented: looks good", names: ["Abebe Bekele"] },
  { text: "Ngaio Tamatea, Head of Finance", names: ["Ngaio Tamatea"] },
  { text: "Dagny Solberg moved the card to Review", names: ["Dagny Solberg"] },
  { text: "Teodora Vlahovic - references.pdf", names: ["Teodora Vlahovic"] },
  { text: "Ilka Hirvonen signed the contract", names: ["Ilka Hirvonen"] },
  { text: "Gwenllian Prys replied in the thread", names: ["Gwenllian Prys"] },
  { text: "Ravshan Yusupov, Procurement", names: ["Ravshan Yusupov"] },
  { text: "Kalani Akana scheduled a meeting", names: ["Kalani Akana"] },
  { text: "Sefa Tuilagi - timesheet - week 42", names: ["Sefa Tuilagi"] },
  { text: "Anahera Rewi uploaded 4 files", names: ["Anahera Rewi"] },
  { text: "Lwazi Ndlovu approved the expense", names: ["Lwazi Ndlovu"] },
  { text: "Zarina Tokhtarova is typing", names: ["Zarina Tokhtarova"] },
  { text: "Wiremu Parata - Interview notes", names: ["Wiremu Parata"] },
  { text: "Makoa Kanoho mentioned you in a comment", names: ["Makoa Kanoho"] },
  { text: "Folake Ogunleye, Operations Lead, Lagos office", names: ["Folake Ogunleye"] },
  { text: "Dumisani Khumalo has 2 open tickets", names: ["Dumisani Khumalo"] },
  { text: "Saule Zhaksybek renamed the sheet", names: ["Saule Zhaksybek"] },
];
