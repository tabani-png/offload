// s18 word lists for the person-name masker (names.ts). Plain data, lower case, no dependency. Given names that are
// also everyday words, months or places (will, may, bill, mark, grace, june, rose, jordan, ...) are deliberately left
// out of GIVEN: they count as names only next to a cue, an honorific or a family name.

const words = (s: string) => new Set(s.split(/\s+/).filter((w) => w !== ""));

/** Common given names across languages (English, Spanish, Portuguese, French, German, Nordic, Slavic, Turkish, Arabic,
 * Persian, South Asian, East Asian, African). */
export const GIVEN = words(`
aaron abby abdul abdullah abel abigail abraham ada adam adebayo adeel adele adil adrian adriana afua agata agnes
ahmad ahmed aidan aiko aisha akash akira akosua alan alba alberto aleksandar aleksander alex alexander
alexandra alexei alexis alfie alfonso alfred ali alice alicia alina alisha alison alistair allan alma alok alvaro
amanda amara amaya ambrose amelia amina amir amira amit amy ana anand anders andre andrea andreas andrei
andres andrew andy aneesh angela angelica angelo anika anil anita anja anke ann anna annabel anne annie anouk
anton antonio anya aoife arash archie ari ariana arjun arnav arne arthur arun arvid asha ashley ashok asif aslan
astrid ayaan ayesha aylin ayumi azadeh baptiste barbara barry bart bartosz beatrice beatriz becky ben benedict
benjamin bernard bernardo bertrand beth bethany bianca bilal birgit bjorn blessing bogdan boris brandon brenda
brian bridget brigitte bruno bryan caitlin callum camila camille candice carina carl carla carlos carmen carolina
caroline carsten cassandra catalina catherine cathy cecile cecilia cedric celine chantal charles charlie charlotte
chen chiamaka chidi chinedu chioma chloe chris christian christina christine christopher chukwuma ciara cillian
claire clara clare claudia claudio colin connor conor constance cormac craig cristina cristiano dagmar dahlia
daisuke damian damien dan dana daniel daniela daniele danielle danny dara darius darren dave david davide dawit
debbie deborah declan deepak deepika denis denise dennis derek desmond diana diane diego dimitri dimitris
dina dirk dmitri dmitry dominic dominika donna dorota doug douglas duncan dylan ebony eddie edgar edith edmund
eduardo edward efua eileen ekaterina elaine eleanor elena eli elias elif elijah elin elisa elisabeth eliza
elizabeth ella ellen ellie elliot emeka emil emilia emily emma emmanuel enrique enzo eric erik erika erin ernesto
esra esteban esther ethan eugene eva evan  evelyn ewa fabian fabio fahad faisal farah farhan farid fatima
fatma federico felipe felix fernanda fernando filip finn fiona florian francesca francesco francis francisco
franz freddie frederik freya fumiko gabriel gabriela gabriele gareth gary gaurav gavin gemma georg george
georgina gerald gerard gianluca gina giorgio giovanni giulia giuseppe gloria goran gordon graham greta gregory
guillaume gunnar gustavo hamid hamza hana hannah hans harish harjit harold harriet harry hassan heather hector
heidi helen helena helga hendrik henrik henry hiroshi hiroko hugo hussein ian ibrahim ida ifeoma igor ilona
imogen imran ines ingrid irene irina isaac isabel isabella isabelle ishaan ismail ivan ivana jack jacob jacqueline
jake jakub james jamie  jana jane janet janine jasmine jason javier jay jayden jean jeff jeffrey jennifer
jenny jens jeremy jerome jesper jessica jesus jiahui jian jie jin jing jo joachim joan joanna joao jocelyn joe
joel johan johann johanna john johnny jon jonas jonathan jordi jorge jose josef joseph josh joshua joyce juan
judith julia julian juliana julie julien julio  jurgen justin kaito kamal kamala kareem karen karim karin
karina karl karla kasia kate katarina katarzyna kate katherine kathryn katie katja kavya kayla keiko keith kelly
ken kenji kenneth kerry kevin khalid kim kimberly kirsten klaus kofi konstantin kristina kumar kwame kwabena
lakshmi lars laura lauren laurent lea leah leila lena leo leon leonardo leonie liam lidia lillian lina linda
lindsay lisa liu lorenzo louis louise luca lucas lucia luciana lucy ludwig luis luisa lukas luke lupita lydia
magdalena magnus mahmoud maja malik mandy manuel manuela marc marcel marco marcos marcus margaret margarita
margot maria mariam mariana marie marina mario marisa marius marta martin martina marwa mary maryam mateo matias
matilda matteo matthew matthias maureen maurice maxim maximilian maya mehdi mehmet mei melanie melissa
mercy mia michael michaela michal michel michelle miguel mikael mike mikhail mila  milena  mina miriam
mohamed mohammad mohammed moira monica monika morgan moritz muhammad mustafa nadia nadine naledi nana naomi
naoto narges natalia natalie natasha nathan nathaniel naveen neha nelson niamh nicholas nick nicola nicolas
nicole nikhil niklas nikolai nikos nils nina noah noel noor nora norbert nuno oliver olivia olga omar oscar
oskar owen pablo padraig pamela paolo patricia patrick paul paula paulo pavel pedro  peter petra philip
philippe pierre pietro pilar piotr pooja prakash pranav prateek priya priyanka quentin quinn rachel radek rafael
rahul raj rajesh rakesh ralph ramon rania raphael rashid ravi rebecca reza ricardo riccardo richard riley rita rob
robert roberta roberto robin rodrigo rohan roland roman ronan rosa rosalind rui ruth ryan sabrina sachin sadia
sahil saira salma sam samantha samir samira samuel sana sandeep sandra sanjay santiago sara sarah sasha saskia
satoshi scott sean sebastian selin serena sergei sergio seth shabnam shane shannon sharon shaun sheila shilpa
shira shreya shu siddharth sienna sigrid silvia simon simone siobhan sipho siddiq sofia sofie sonia sophia sophie
stefan stefanie stefano stella stephanie stephen steve steven stuart suleiman sunil susan susanne suzanne sven
svetlana sylvia tamara tanvir tanya tara tariq tatiana teresa thabo theo theodore thomas thor tim timothy tina
tobias tom tomas tomasz toni tony tove tristan tuan uchenna ulrich uma usman valentina valeria vanessa varun
vera veronica viktor vikram vincent vinod vivek vladimir walter wei wen werner wiktoria william
wojciech xavier xin yan yara yasmin yasmine yemi yetunde yi yohannes yolanda yong yosef yu yuki yuri yusuf
yvonne zainab zane zara zeynep zhang zhen zoe zofia
`);

/** Common family names (used when the first token of a pair is not a known given name). */
export const FAMILY = words(`
abbott adams afolabi ahmed akhtar alexander ali allen alvarez anderson andersson appiah araujo bailey  
banerjee barnes becker  bennett bergstrom bianchi     campbell  castillo chan chang
chaudhry chen choi chowdhury clark clarke collins     davies davis dawson diaz dubois duong
edwards eriksson evans fernandes fernandez ferrari fischer fitzgerald flores fofanah  fournier garcia 
gomez gonzalez       gupta haddad  hansen harris hassan  hernandez 
hoang hoffmann  horvath  hughes hussain ibrahim iyer jackson jansen jensen johansson johnson jones joshi
kaya khan kim  kowalczyk kowalski kumar  larsen laurent lee lewis  lindqvist  liu lopez lundberg
malik  martinez meyer mehta mensah miller mishra mitchell moore moreau morris muller murphy nakamura nair
nguyen nielsen novak nowak obi odhiambo okafor okonkwo olsen osei owusu  patel perez peters petrov phillips
popescu   rahman ramos rao reddy reyes richter rivera roberts robinson rodriguez rossi russo sanchez
santos sato schmidt schneider  shah sharma silva singh smith sokolov suzuki tanaka   thompson
torres tran  varga vasquez wagner  wang  watanabe weber  williams wilson wong  wu yamamoto
yang  zhang zhao zimmermann
`);

/** Capitalised words that are never a name on their own: UI labels, headings, job words, months, days, greetings,
 * pronouns and other everyday words that start lines or titles. */
export const COMMON = words(`
a about above accept account accounts action actions active activity add added address admin advanced after again
agenda all allow also amount an analysis analyst and annual answer any api app apply approve approved april archive
are as ask assign assigned assistant at attach attached attachment august auto available away back balance bank
basic be before below best beta bill billing blog board body bold book booking both brief browse budget build
business but button by calendar call cancel card care case cash category cc center change chat check checkout
choose clear click client close closed code collapse comment comments company compose confirm connect contact
contacts content continue copy cost create created credit current customer customers daily dashboard data date
day dear december default delete deliver delivery department design designer details developer director discount
document documents done download draft due during each edit editor education email end engineer engineering enter
error event every everyone executive expense expenses experience export failed fax february feedback file files
filter final finance find first follow for format forward free friday from full general get go good great group
guest have head hello help here hey hi hide high history hold home hour hours how i if import in inbox info
information insert internal into invoice invoices is issue it item items january job join journal july june just
key label labels language last late latest launch lead leads learn legal let level line link list live load log
login logout low mail main make manage manager march marketing may me media meeting meetings member members menu
merge message messages method mobile monday month more morning move my name need new news next no none not note
notes notice november now number october of off office ok on one only open operations options or order orders
other our out overview owner page paid partner password pay payment payments pending people per phone plan please
policy post preview price primary print priority privacy private pro product profile project projects public
purchase quarter quarterly queue quick quote re read ready receipt recent record records refund regards region
reject release reminder remove reply report reports request requests reset resume return review role sales
saturday save schedule search second security see select send senior sent september service services session
settings setup share sheet ship shipping show sign skills solved some sort source spam stage standard start status
step stop store subject submit subscribe summary sunday support sync system table tag task tasks tax team template
terms test thank thanks that the their there these this thursday ticket time title to today total track transfer
trash tuesday type unread update upload urgent us use user users version video view wednesday week weekly welcome
what when where who why with work workflow write year yes yesterday you your
re: fwd fw dashboard candidate applicant requester assignee recipient sender ceo cto cfo coo vp svp evp hr qa ux ui
it intern lead principal staff junior associate partner founder cofounder chair chairman president officer
specialist coordinator consultant representative rep agent administrator accountant bookkeeper recruiter
backend frontend fullstack full-stack product products success customer operations ops growth people talent
acquisition recruiting hiring sourcing screening onboarding offer interview interviews scorecard scorecards pipeline
qualified unqualified prospect prospects opportunity opportunities deal deals contract contracts renewal renewals
reconciliation reconcile payable receivable ledger journal ledgers statement statements remittance remit vendor
vendors supplier suppliers bills purchase po balance sheet profit loss cashflow audit payroll timesheet timesheets
macro macros solved pending escalated escalation internal public satisfaction rating tier priority urgent normal
high low
application applications resume resumes cv cvs portfolio letter cover references position role opening
world will dark light unit list forest ocean sale net gross sub vs required needed
january february march april may june july august september october november december jan feb mar apr jun jul aug
sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat
sun spring summer autumn fall winter q1 q2 q3 q4 christmas easter
hiring manager sir madam team everyone all there folks guys colleagues customer support friends
north south east west central city street road avenue square station airport park
english french german spanish italian dutch chinese japanese arabic
`);

/** Words that make a capitalised run an organisation (or a place), never a person. */
export const ORG = words(`
ltd limited inc incorporated llc llp plc gmbh ag sa sarl bv nv oy ab as kk pty pte corp corporation co company
companies group holdings bank banking capital ventures partners partnership fund funds foods food logistics energy
clinic clinics studio studios lab labs systems solutions services supplies supply technologies technology tech
software analytics health healthcare insurance payments robotics legal travel retail print printing catering
utilities packaging couriers courier cleaning consulting consultants agency associates university college school
academy institute foundation trust council department ministry hospital pharmacy motors airlines airways media
network networks digital cloud data security industries international global worldwide enterprises store stores
shop market markets express freight shipping transport properties property realty homes construction engineering
design designs marketing advertising publishing press records films pictures entertainment games gaming hotel
hotels resort restaurant cafe bar kitchen bakery brewery farm farms estates investments advisors advisory
management collective cooperative union club society church
`);

/** Products, apps and sites that appear in window titles and OCR. A run with one of these is not a person. */
export const PRODUCT = words(`
google gmail chrome docs sheets slides drive calendar meet youtube android apple mac macos iphone ipad safari
finder preview pages numbers keynote facetime icloud microsoft outlook excel word powerpoint teams onedrive
sharepoint windows azure linkedin facebook instagram whatsapp twitter slack zoom notion linear jira confluence
trello asana github gitlab bitbucket figma sketch canva dropbox box hubspot salesforce pipedrive zendesk intercom
freshdesk helpscout shopify stripe paypal xero quickbooks sage netsuite greenhouse lever workday bamboohr gusto
rippling ashby airtable monday clickup miro loom calendly docusign typeform mailchimp klaviyo amazon aws ebay
etsy uber lyft spotify netflix acrobat adobe photoshop illustrator terminal vscode code cursor claude chatgpt
openai anthropic offload offload's postgres stripe monzo atlassian revolut wise
`);

/** Multi-word names of companies and products that look like a given + family name. Matched before detection. */
export const PROTECTED_PHRASES = [
  "Morgan Stanley", "Goldman Sachs", "Charles Schwab", "Wells Fargo", "Dow Jones", "Marks Spencer", "Ernst Young",
  "Dr Pepper", "Dr. Pepper", "Calvin Klein", "Ralph Lauren", "Hugo Boss", "Louis Vuitton", "Estee Lauder",
  "Walt Disney", "Tommy Hilfiger", "JP Morgan", "J.P. Morgan", "Ben & Jerry", "Ben and Jerry", "Jack Daniels", "Hacker News", "Visual Studio", "Ruby on Rails",
];

/** Greetings and closings after which any capitalised, non-common token is a name ("Dear Siobhan", "Thanks Sam"). */
export const GREETING_CUES = words("dear hi hello hey hiya thanks thank cheers attn attention regards love sincerely signed cc bcc");
/** Role words that name the person after a colon ("Candidate: Wen Tanaka", "Requester: Rosa"). */
export const ROLE_CUES = words(`
candidate applicant contact requester requestor assignee customer client name owner referee reference interviewer
interviewee employee manager recruiter agent rep tenant patient student reviewer approver organiser organizer
firstname lastname fullname givenname surname familyname
`);
/** Two-word strong cues, lower case ("assigned to Lea"). */
export const STRONG_CUE_PAIRS = ["assigned to", "reported by", "requested by", "submitted by", "approved by", "name is", "name:", "full name", "contact person", "account owner", "sales rep", "hiring manager", "point of contact"];
/** Cues after which a token needs a given name or a pair to count ("from Kofi", not "from Gmail"). */
export const WEAK_CUES = words("from by with to for meet call ask tell met and or cc via per told asked spoke owner");

/** Closing lines after which the next line is a signature. */
export const CLOSINGS = /^(?:best|best wishes|best regards|kind regards|warm regards|warmly|regards|many thanks|thanks|thank you|thanks again|cheers|sincerely|yours|yours sincerely|yours truly|all the best|talk soon|speak soon|ta|love|--|—|–)[,.!]?$/i;

/** Mailboxes that belong to a role, not a person. */
export const ROLE_MAILBOXES = words(`
info support sales hello hi team admin billing accounts accounting ap ar noreply no-reply donotreply contact office
hr jobs careers press help ops finance invoices invoice orders mail me newsletter marketing security abuse
postmaster webmaster privacy legal service services customer customers care feedback partners partner bookings
reservations enquiries inquiries notifications alerts updates news
`);

/** Given names that are also everyday words or months: names only before a family/given name or after a cue. */
export const AMBIGUOUS_GIVEN = words("will may june april august mark bill grace rose hope joy faith summer autumn dawn sky chase hunter page art pat sue don ray guy frank earl miles max victor violet ruby amber jade pearl iris lily ivy holly penny rich drew dean reed wade lane jordan paris austin");

export const HONORIFICS = words("mr mrs ms miss mx dr prof professor sir dame mme mlle herr frau sr sra srta dott");
export const PARTICLES = words("van von der den de da di del della des du la le bin bint ibn al el ter ten dos das");
