#!/usr/bin/env python3
"""
NexusCollect P2G Collection Platform - demo data generator.

Produces an internally consistent seed dataset in ../demo-data/.
Deterministic: seeded RNG, so re-running reproduces byte-identical output.

Guarantees asserted at the end of this script (see verify()):
  1. Every PSID has a valid Damm check digit.
  2. sum(line_items) == assessed_amount for every assessment.
  3. sum(applied allocations) + unapplied == gross, for every payment.
  4. assessment.allocated == sum of its applied allocations.
  5. assessment.balance == payable - allocated, and status is consistent.
  6. Recon source files tie to the platform ledger except for exactly the
     11 deliberately planted breaks, whose amounts are enumerated in
     expected-results.json.
  7. Every EMVCo QR payload carries a correct CRC-16/CCITT-FALSE
     (except the one deliberately corrupted sample).
"""
import csv, json, os, random, hashlib
from datetime import date, datetime, timedelta, timezone

random.seed(20260730)
# Fixed generation timestamp so re-runs are byte-identical (no datetime.now()).
GENERATED_AT = "2026-07-30T13:00:00Z"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo-data")
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------------------
# Damm checksum (see design doc section 7.2) - detects all single-digit errors
# AND all adjacent transpositions (Luhn does not).
# ----------------------------------------------------------------------------
DAMM = [
    [0,3,1,7,5,9,8,6,4,2],[7,0,9,2,1,5,4,8,6,3],[4,2,0,6,8,7,1,3,5,9],
    [1,7,5,0,9,8,3,4,2,6],[6,1,2,3,0,4,5,9,7,8],[3,6,7,4,2,0,9,5,8,1],
    [5,8,6,9,7,2,0,1,3,4],[8,9,4,5,3,6,2,0,1,7],[9,4,3,8,6,1,7,2,0,5],
    [2,5,8,1,4,3,6,7,9,0],
]
def damm_digit(digits: str) -> str:
    i = 0
    for ch in digits:
        i = DAMM[i][int(ch)]
    return str(i)

def damm_valid(full: str) -> bool:
    i = 0
    for ch in full:
        i = DAMM[i][int(ch)]
    return i == 0

# ISO 7064 MOD-97-10, used for ISO 11649 RF creditor references
def rf_reference(psid: str) -> str:
    rearranged = psid + "271500"           # 'R'=27, 'F'=15, then "00"
    check = 98 - (int(rearranged) % 97)
    return f"RF{check:02d}{psid}"

# CRC-16/CCITT-FALSE for EMVCo QR tag 63
def crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc

def tlv(tag: str, value: str) -> str:
    return f"{tag}{len(value):02d}{value}"

# ----------------------------------------------------------------------------
# Reference schemes
# ----------------------------------------------------------------------------
REFERENCE_SCHEMES = [
    # code, agency, len, prefix, checksum, seq_digits, rand_digits, platform_minted, note
    ("PSID-FBR-17",   "FBR",  17, "12", "DAMM",      6, 4, True,  "Federal tax PSID"),
    ("PSID-PRA-17",   "PRA",  17, "21", "DAMM",      6, 4, True,  "Punjab services sales tax"),
    ("PSID-SRB-17",   "SRB",  17, "22", "DAMM",      6, 4, True,  "Sindh services sales tax"),
    ("PSID-ETPB-17",  "ETPB", 17, "31", "DAMM",      6, 4, True,  "Excise & Taxation Punjab"),
    ("PSID-PSCA-17",  "PSCA", 17, "41", "DAMM",      6, 4, True,  "Traffic e-challan"),
    ("CRN-WASA-13",   "WASA", 13, "51", "DAMM",      6, 0, True,  "Water consumer bill"),
    ("PSID-LHC-17",   "LHC",  17, "61", "DAMM",      6, 4, True,  "Court fees & deposits"),
    ("PSID-BOR-17",   "BOR",  17, "71", "DAMM",      6, 4, True,  "e-Stamp duty"),
    ("LEGACY-NADRA-14","NADRA",14, "88", "LUHN",     11, 0, False, "Legacy NADRA app no, Luhn, no product code"),
]

# ----------------------------------------------------------------------------
# Agencies
# ----------------------------------------------------------------------------
AGENCIES = [
    # code, name, tier, jurisdiction, settlement_model, treasury_iban, bic, cutoff
    ("FBR",  "Federal Board of Revenue",                  "FEDERAL",         "PK",
     "HYBRID",             "PK36NBPA0000001234567890", "NBPAPKKA", "18:00"),
    ("PRA",  "Punjab Revenue Authority",                  "PROVINCIAL",      "PK-PB",
     "COLLECTOR_OF_RECORD","PK22NBPA0000002234567890", "NBPAPKKA", "18:00"),
    ("SRB",  "Sindh Revenue Board",                       "PROVINCIAL",      "PK-SD",
     "PASS_THROUGH",       "PK41NBPA0000003234567890", "NBPAPKKA", "17:00"),
    ("ETPB", "Excise, Taxation & Narcotics Control, Punjab","PROVINCIAL",     "PK-PB",
     "HYBRID",             "PK75NBPA0000004234567890", "NBPAPKKA", "18:00"),
    ("PSCA", "Punjab Safe Cities Authority",              "AUTONOMOUS_BODY", "PK-PB",
     "COLLECTOR_OF_RECORD","PK09NBPA0000005234567890", "NBPAPKKA", "20:00"),
    ("WASA", "Water & Sanitation Agency, Lahore",         "LOCAL",           "PK-LHR",
     "COLLECTOR_OF_RECORD","PK53NBPA0000006234567890", "NBPAPKKA", "18:00"),
    ("LHC",  "Lahore High Court",                         "JUDICIAL",        "PK-PB",
     "PASS_THROUGH",       "PK88NBPA0000007234567890", "NBPAPKKA", "15:00"),
    ("BOR",  "Board of Revenue, Punjab (e-Stamp)",        "PROVINCIAL",      "PK-PB",
     "HYBRID",             "PK17NBPA0000008234567890", "NBPAPKKA", "16:00"),
    ("NADRA","National Database & Registration Authority","FEDERAL",         "PK",
     "PASS_THROUGH",       "PK64NBPA0000009234567890", "NBPAPKKA", "18:00"),
]

# ----------------------------------------------------------------------------
# Revenue heads (government chart of accounts)
# ----------------------------------------------------------------------------
REVENUE_HEADS = [
    # agency, code, name, fund, object_class, refundable
    ("FBR", "B01101","Income Tax on Companies",              "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B01102","Income Tax on Individuals & AOPs",     "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B01110","Withholding Tax - Contracts (s.153)",  "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B02341","Sales Tax on Goods (Domestic)",        "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B02388","Default Surcharge - Income Tax",       "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B02391","Penalty - Income Tax",                 "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B02389","Default Surcharge - Sales Tax",        "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B02392","Penalty - Sales Tax",                  "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B03110","Customs Duty",                         "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B03115","Additional Customs Duty",              "FEDERAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("FBR", "B09999","Rounding Relief - Federal",            "FEDERAL_CONSOLIDATED","OTHER",      False),
    ("PRA", "P02100","Punjab Sales Tax on Services",         "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("PRA", "P02188","Default Surcharge - PST",              "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("PRA", "P02191","Penalty - PST",                        "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("PRA", "P09999","Rounding Relief - Punjab",             "PROVINCIAL_CONSOLIDATED","OTHER",      False),
    ("SRB", "S02100","Sindh Sales Tax on Services",          "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("SRB", "S02188","Default Surcharge - SST",              "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("ETPB","E04210","Motor Vehicle Token Tax",              "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("ETPB","E04215","Motor Vehicle Registration Fee",       "PROVINCIAL_CONSOLIDATED","FEE",       False),
    ("ETPB","E04220","Professional Tax",                     "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("ETPB","E04288","Late Payment Surcharge - MVT",         "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("ETPB","E04291","Property Tax (Urban Immovable)",       "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("PSCA","C05110","Traffic Fines - Moving Violations",    "PROVINCIAL_CONSOLIDATED","FINE",      False),
    ("PSCA","C05115","Traffic Fines - Parking & Static",     "PROVINCIAL_CONSOLIDATED","FINE",      False),
    ("PSCA","C05191","Escalation Penalty - Traffic",         "PROVINCIAL_CONSOLIDATED","FINE",      False),
    ("WASA","W06110","Water Charges - Domestic",             "PROVINCIAL_CONSOLIDATED","NON_TAX_RECEIPT",False),
    ("WASA","W06115","Sewerage & Conservancy Charges",       "PROVINCIAL_CONSOLIDATED","NON_TAX_RECEIPT",False),
    ("WASA","W06188","Arrears Surcharge - Water",            "PROVINCIAL_CONSOLIDATED","NON_TAX_RECEIPT",False),
    ("LHC", "J07110","Court Fees",                           "PROVINCIAL_CONSOLIDATED","FEE",       False),
    ("LHC", "J07910","Security Deposit - Litigation",        "PUBLIC_ACCOUNT",         "DEPOSIT",   True),
    ("BOR", "R08110","Stamp Duty on Instruments",            "PROVINCIAL_CONSOLIDATED","TAX_RECEIPT",False),
    ("BOR", "R08115","Registration Fee - Immovable Property","PROVINCIAL_CONSOLIDATED","FEE",       False),
    ("BOR", "R08910","Tender / Earnest Money Deposit",       "PUBLIC_ACCOUNT",         "DEPOSIT",   True),
    ("NADRA","N09110","CNIC & Identity Document Fees",       "FEDERAL_CONSOLIDATED",  "FEE",       False),
    ("FBR", "B08110","Dishonoured Instrument Charge",        "FEDERAL_CONSOLIDATED",  "NON_TAX_RECEIPT",False),
]

# ----------------------------------------------------------------------------
# Collection products
# ----------------------------------------------------------------------------
# (code, agency, name, category, scheme, amount_rule, partial, overpay_treatment,
#  under_tol, over_tol, waterfall, channels, instruments, instr_policy, gating,
#  head_mapping, secondary_keys, fee_bearer, deposit)
CHAN_ALL   = "APP|QR|RTP|BILLER|ATM|IBANKING|OTC_CASH|CHEQUE|CARD|WALLET|AGENT|API"
CHAN_DIG   = "APP|QR|RTP|BILLER|ATM|IBANKING|CARD|WALLET|AGENT|API"
CHAN_NOCHQ = "APP|QR|RTP|BILLER|ATM|IBANKING|OTC_CASH|CARD|WALLET|AGENT|API"

PRODUCTS = [
 ("FBR-IT-COMP","FBR","Income Tax - Companies (Advance/Demand)","TAX","PSID-FBR-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"PENALTY_FIRST",CHAN_ALL,"CHEQUE|PAY_ORDER|DEMAND_DRAFT|CASH",
  "PROVISIONAL_ON_LODGEMENT","NONE",
  {"PRINCIPAL":"B01101","SURCHARGE":"B02388","PENALTY":"B02391","ROUNDING":"B09999"},["NTN"],"AGENCY",False),
 ("FBR-IT-IND","FBR","Income Tax - Individuals & AOPs","TAX","PSID-FBR-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"PRINCIPAL_FIRST",CHAN_ALL,"CHEQUE|PAY_ORDER|CASH",
  "ON_CLEARING","NONE",
  {"PRINCIPAL":"B01102","SURCHARGE":"B02388","PENALTY":"B02391","ROUNDING":"B09999"},["CNIC","NTN"],"AGENCY",False),
 ("FBR-WHT-153","FBR","Withholding Tax - Contracts s.153","TAX","PSID-FBR-17","ASSESSED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY","APP|IBANKING|API|CHEQUE","CHEQUE|PAY_ORDER",
  "ON_CLEARING","NONE",{"PRINCIPAL":"B01110","ROUNDING":"B09999"},["NTN"],"AGENCY",False),
 ("FBR-ST-DOM","FBR","Sales Tax on Goods - Monthly Return","TAX","PSID-FBR-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"PENALTY_FIRST",CHAN_ALL,"CHEQUE|PAY_ORDER",
  "PROVISIONAL_ON_LODGEMENT","NONE",
  {"PRINCIPAL":"B02341","SURCHARGE":"B02389","PENALTY":"B02392","ROUNDING":"B09999"},["STRN","NTN"],"AGENCY",False),
 ("FBR-CUSTOMS","FBR","Customs Duty & Taxes (PSW/GD)","DUTY","PSID-FBR-17","ASSESSED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY",CHAN_DIG,"PAY_ORDER|DEMAND_DRAFT",
  "PROVISIONAL_WITH_GATE_HOLD","RELEASES_GOODS",
  {"PRINCIPAL":"B03110","FEE":"B03115","ROUNDING":"B09999"},["GD_NO","NTN"],"AGENCY",False),
 ("FBR-DISHON-CHG","FBR","Dishonoured Instrument Charge","PENALTY","PSID-FBR-17","FIXED",
  False,"REJECT",0,0,"EXPLICIT_ONLY",CHAN_NOCHQ,"CASH",
  "ON_CLEARING","NONE",{"PRINCIPAL":"B08110"},["NTN"],"PAYER",False),
 ("PRA-PST-SVC","PRA","Punjab Sales Tax on Services - Monthly","TAX","PSID-PRA-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"PRO_RATA",CHAN_ALL,"CHEQUE|PAY_ORDER",
  "PROVISIONAL_ON_LODGEMENT","NONE",
  {"PRINCIPAL":"P02100","SURCHARGE":"P02188","PENALTY":"P02191","ROUNDING":"P09999"},["PRA_REG","NTN"],"AGENCY",False),
 ("SRB-SST-SVC","SRB","Sindh Sales Tax on Services - Monthly","TAX","PSID-SRB-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"PENALTY_FIRST",CHAN_DIG,"",
  "ON_CLEARING","NONE",{"PRINCIPAL":"S02100","SURCHARGE":"S02188"},["SRB_REG","NTN"],"AGENCY",False),
 ("ETPB-TOKEN-CAR","ETPB","Motor Vehicle Token Tax - Private Car","TAX","PSID-ETPB-17","ASSESSED",
  False,"ABSORB",100,500,"OLDEST_FIRST",CHAN_ALL,"CHEQUE|CASH",
  "ON_CLEARING","BLOCKS_SERVICE",
  {"PRINCIPAL":"E04210","SURCHARGE":"E04288","ROUNDING":"P09999"},["VEHICLE_REG","CNIC"],"PAYER",False),
 ("ETPB-REG-NEW","ETPB","Motor Vehicle Registration - New","FEE","PSID-ETPB-17","ASSESSED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY",CHAN_NOCHQ,"CASH",
  "ON_CLEARING","BLOCKS_SERVICE",{"PRINCIPAL":"E04215"},["CHASSIS_NO","CNIC"],"PAYER",False),
 ("ETPB-PROF-TAX","ETPB","Professional Tax - Businesses","TAX","PSID-ETPB-17","ASSESSED",
  True,"ABSORB",100,200,"OLDEST_FIRST",CHAN_ALL,"CHEQUE|POST_DATED_CHEQUE|CASH",
  "ON_CLEARING","NONE",{"PRINCIPAL":"E04220","SURCHARGE":"E04288"},["NTN"],"AGENCY",False),
 ("ETPB-PROP-TAX","ETPB","Property Tax - Urban Immovable","BILL","PSID-ETPB-17","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"OLDEST_FIRST",CHAN_ALL,"CHEQUE|CASH",
  "ON_CLEARING","NONE",{"PRINCIPAL":"E04291","SURCHARGE":"E04288","ROUNDING":"P09999"},
  ["PROPERTY_ID","CNIC"],"AGENCY",False),
 ("PSCA-CHALLAN-MOV","PSCA","Traffic e-Challan - Moving Violation","FINE","PSID-PSCA-17","ASSESSED",
  False,"ABSORB",0,100,"PENALTY_FIRST",CHAN_ALL,"CASH",
  "ON_CLEARING","BLOCKS_SERVICE",{"PRINCIPAL":"C05110","PENALTY":"C05191"},
  ["VEHICLE_REG","CNIC","DL_NO"],"PAYER",False),
 ("PSCA-CHALLAN-PARK","PSCA","Traffic e-Challan - Parking","FINE","PSID-PSCA-17","ASSESSED",
  False,"ABSORB",0,100,"PENALTY_FIRST",CHAN_ALL,"CASH",
  "ON_CLEARING","NONE",{"PRINCIPAL":"C05115","PENALTY":"C05191"},["VEHICLE_REG"],"PAYER",False),
 ("WASA-WATER-DOM","WASA","Water & Sewerage Bill - Domestic","BILL","CRN-WASA-13","ASSESSED",
  True,"CREDIT_ON_ACCOUNT",100,100,"OLDEST_FIRST",CHAN_ALL,"CHEQUE|CASH",
  "ON_CLEARING","NONE",{"PRINCIPAL":"W06110","FEE":"W06115","SURCHARGE":"W06188"},
  ["CRN","PROPERTY_ID"],"AGENCY",False),
 ("LHC-COURT-FEE","LHC","Court Fee - Civil Filing","FEE","PSID-LHC-17","ASSESSED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY",CHAN_ALL,"PAY_ORDER|CASH",
  "PROVISIONAL_WITH_GATE_HOLD","BLOCKS_SERVICE",{"PRINCIPAL":"J07110"},["CASE_NO","CNIC"],"PAYER",False),
 ("LHC-SEC-DEPOSIT","LHC","Security Deposit - Litigation","DEPOSIT","PSID-LHC-17","ASSESSED",
  False,"REJECT",0,0,"EXPLICIT_ONLY",CHAN_DIG,"PAY_ORDER|DEMAND_DRAFT",
  "ON_CLEARING","BLOCKS_SERVICE",{"PRINCIPAL":"J07910"},["CASE_NO"],"AGENCY",True),
 ("BOR-STAMP-DUTY","BOR","Stamp Duty - Property Instrument","STAMP","PSID-BOR-17","ASSESSED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY",CHAN_ALL,"PAY_ORDER|DEMAND_DRAFT|CASH",
  "PROVISIONAL_WITH_GATE_HOLD","BLOCKS_SERVICE",
  {"PRINCIPAL":"R08110","FEE":"R08115"},["INSTRUMENT_NO","CNIC"],"PAYER",False),
 ("BOR-TENDER-DEP","BOR","Tender / Earnest Money Deposit","DEPOSIT","PSID-BOR-17","OPEN",
  False,"REJECT",0,0,"EXPLICIT_ONLY",CHAN_DIG,"PAY_ORDER|DEMAND_DRAFT",
  "ON_CLEARING","BLOCKS_SERVICE",{"PRINCIPAL":"R08910"},["TENDER_REF","NTN"],"AGENCY",True),
 ("NADRA-CNIC-FEE","NADRA","CNIC Issuance / Renewal Fee","FEE","LEGACY-NADRA-14","FIXED",
  False,"AUTO_REFUND",0,0,"EXPLICIT_ONLY",CHAN_ALL,"CASH",
  "ON_CLEARING","BLOCKS_SERVICE",{"PRINCIPAL":"N09110"},["APPLICATION_NO","CNIC"],"PAYER",False),
]

FIXED_AMOUNTS = {"FBR-DISHON-CHG": 500_00, "NADRA-CNIC-FEE": 1_500_00}

# ----------------------------------------------------------------------------
# Payers
# ----------------------------------------------------------------------------
COMPANY_NAMES = [
 "Ahmed Traders (Pvt) Ltd","Lahore Textile Mills Ltd","Indus Logistics (Pvt) Ltd",
 "Karachi Steel Works Ltd","Ravi Engineering (Pvt) Ltd","Meridian Foods (Pvt) Ltd",
 "Sapphire Chemicals Ltd","Northern Cement Company Ltd","Gulberg Software House (Pvt) Ltd",
 "Pak Agro Processing Ltd","Descon Fabrication (Pvt) Ltd","Shalimar Pharma (Pvt) Ltd",
 "Zenith Clearing Agents (Pvt) Ltd","Orient Auto Parts (Pvt) Ltd","Crescent Packaging Ltd",
]
INDIVIDUAL_NAMES = [
 "Muhammad Ahmed Khan","Fatima Zahra Siddiqui","Ali Hassan Raza","Ayesha Bibi",
 "Usman Ghani Butt","Zainab Malik","Bilal Ahmad Chaudhry","Sana Tariq",
 "Hamza Yousaf Sheikh","Maryam Nawaz Cheema","Imran Shah Bukhari","Nadia Parveen",
 "Kamran Akmal Dar","Rabia Sultana","Farhan Javed Mughal","Hina Rashid",
 "Tariq Mehmood Awan","Saima Noor","Adnan Sami Qureshi","Kiran Shahzadi",
 "Waqar Younis Gill","Amna Batool","Shahid Afridi Khan","Nazia Hassan",
 "Junaid Jamshed Baig",
]
BANKS = [("HABBPKKA","Habib Bank Limited"),("UNILPKKA","United Bank Limited"),
         ("MUCBPKKA","MCB Bank Limited"),("ALFHPKKA","Bank Alfalah"),
         ("MEZNPKKA","Meezan Bank"),("NBPAPKKA","National Bank of Pakistan"),
         ("SCBLPKKX","Standard Chartered Pakistan"),("FAYSPKKA","Faysal Bank"),
         ("JSBLPKKA","JS Bank"),("EASYPKKA","Easypaisa (TMB)")]

# ============================================================================
# BUILD
# ============================================================================
scheme_by_code = {s[0]: s for s in REFERENCE_SCHEMES}
product_by_code = {}
head_id = {}   # (agency, head_code) -> id string
for a, c, *_ in REVENUE_HEADS:
    head_id[(a, c)] = f"RH-{a}-{c}"

seq_counter = {}
# 4-digit product code embedded in every PSID, so a channel can label the payable
# before resolving it and a teller can tell one scheme from another by eye (design
# doc section 7.2). Assigned in declaration order.
psid_product_code = {}

def make_psid(scheme_code: str, product_code: str) -> str:
    s = scheme_by_code[scheme_code]
    prefix, total_len, algo, seq_d, rnd_d = s[3], s[2], s[4], s[5], s[6]
    # Only platform-minted schemes embed the 4-digit product code; a legacy scheme
    # the platform did not design carries whatever the agency already uses.
    pcode = psid_product_code[product_code] if s[7] else ""
    n = seq_counter.get(scheme_code, 0) + 1
    seq_counter[scheme_code] = n
    body_len = total_len - len(prefix) - len(pcode) - 1
    seq_part = str(n).zfill(min(seq_d, body_len))
    rnd_part = "".join(str(random.randint(0, 9)) for _ in range(rnd_d))
    body = (seq_part + rnd_part)[:body_len].zfill(body_len)
    stem = prefix + pcode + body
    if algo == "DAMM":
        return stem + damm_digit(stem)
    if algo == "LUHN":
        tot, alt = 0, True
        for ch in reversed(stem):
            d = int(ch)
            if alt:
                d *= 2
                if d > 9: d -= 9
            tot += d; alt = not alt
        return stem + str((10 - tot % 10) % 10)
    return stem + "0"

# ---- payers ----
payers = []
for i, nm in enumerate(COMPANY_NAMES):
    ntn = f"{1000000 + i*137:07d}-{(i % 9) + 1}"
    payers.append(dict(
        payer_id=f"PY-C{i+1:03d}", payer_type="COMPANY", primary_id_type="NTN",
        primary_id_value=ntn, primary_id_last4=ntn[-4:], name=nm,
        msisdn_e164=f"+92300{1000000 + i*4211:07d}"[:14],
        email=f"tax@{nm.split()[0].lower()}.com.pk",
        raast_id_type="MSISDN", raast_id_value=f"+92300{1000000 + i*4211:07d}"[:14],
        raast_id_expires_on="", kyc_level="FULL", risk_rating="LOW", status="ACTIVE"))
for i, nm in enumerate(INDIVIDUAL_NAMES):
    cnic = f"35202-{2000000 + i*3571:07d}-{(i % 9) + 1}"
    exp = "2027-03-31" if i == 7 else ("2026-06-30" if i == 12 else "")
    payers.append(dict(
        payer_id=f"PY-I{i+1:03d}", payer_type="INDIVIDUAL", primary_id_type="CNIC",
        primary_id_value=cnic, primary_id_last4=cnic[-4:], name=nm,
        msisdn_e164=f"+9230{11000000 + i*7919:08d}"[:14],
        email=f"{nm.split()[0].lower()}{i}@example.pk",
        raast_id_type="MSISDN", raast_id_value=f"+9230{11000000 + i*7919:08d}"[:14],
        raast_id_expires_on=exp, kyc_level="BASIC" if i % 3 else "FULL",
        risk_rating="MEDIUM" if i == 19 else "LOW", status="ACTIVE"))
companies = [p for p in payers if p["payer_type"] == "COMPANY"]
individuals = [p for p in payers if p["payer_type"] == "INDIVIDUAL"]

# ---- vehicles / properties / accounts (for secondary lookup demos) ----
VEHICLES = [f"LEA-{17 + (i % 5)}-{1000 + i*137}" for i in range(20)]
payer_accounts = []
for i, p in enumerate(individuals[:15]):
    payer_accounts.append(dict(
        payer_account_id=f"PA-VEH-{i+1:03d}", payer_id=p["payer_id"], agency_code="ETPB",
        product_code="ETPB-TOKEN-CAR", crn=VEHICLES[i], account_label=f"Private Car - {VEHICLES[i]}",
        attributes=json.dumps({"vehicle_reg": VEHICLES[i], "engine_cc": 1000 + (i % 4) * 300,
                               "make": ["Toyota","Honda","Suzuki","KIA"][i % 4]}), status="ACTIVE"))
for i, p in enumerate(individuals[:12]):
    crn = f"51{400000 + i*777:06d}"
    crn = crn + damm_digit(crn)
    payer_accounts.append(dict(
        payer_account_id=f"PA-WAT-{i+1:03d}", payer_id=p["payer_id"], agency_code="WASA",
        product_code="WASA-WATER-DOM", crn=crn,
        account_label=f"House {12 + i}, Street {4 + (i % 7)}, Model Town, Lahore",
        attributes=json.dumps({"property_id": f"MT-{1200 + i}", "connection_size_mm": 20}),
        status="ACTIVE"))

# ---- assessments ----
TODAY = date(2026, 7, 30)
assessments, line_items = [], []
li_seq = 0

def add_assessment(product_code, payer, issue_offset, due_offset, principal_minor,
                   surcharge_minor=0, penalty_minor=0, fee_minor=0, discount_minor=0,
                   external_ref="", metadata=None, tax_period="2025-26",
                   payer_account_id="", expiry_offset=None, source="AGENCY_API"):
    global li_seq
    p = product_by_code[product_code]
    agency = p["agency_code"]
    psid = make_psid(p["reference_scheme_code"], product_code)
    issue = TODAY + timedelta(days=issue_offset)
    due = TODAY + timedelta(days=due_offset)
    expiry = "" if expiry_offset is None else (TODAY + timedelta(days=expiry_offset)).isoformat()
    assessed = principal_minor + surcharge_minor + penalty_minor + fee_minor
    payable = assessed - discount_minor
    aid = f"AS-{len(assessments)+1:05d}"
    hm = p["head_mapping"]
    rows = [("PRINCIPAL", principal_minor, hm.get("PRINCIPAL"))]
    if surcharge_minor: rows.append(("SURCHARGE", surcharge_minor, hm.get("SURCHARGE") or hm["PRINCIPAL"]))
    if penalty_minor:   rows.append(("PENALTY",   penalty_minor,   hm.get("PENALTY")   or hm["PRINCIPAL"]))
    if fee_minor:       rows.append(("FEE",       fee_minor,       hm.get("FEE")       or hm["PRINCIPAL"]))
    prio = {"FEE": 10, "PENALTY": 20, "SURCHARGE": 30, "INTEREST": 40, "PRINCIPAL": 50}
    for i, (lt, amt, hc) in enumerate(rows, start=1):
        li_seq += 1
        line_items.append(dict(
            line_item_id=f"LI-{li_seq:06d}", assessment_id=aid, seq=i, line_type=lt,
            revenue_head_code=hc, revenue_head_id=head_id[(agency, hc)],
            tax_period=tax_period, description=f"{lt.title()} - {p['name']}",
            amount_minor=amt, allocated_minor=0, allocation_priority=prio[lt]))
    assessments.append(dict(
        assessment_id=aid, psid=psid, rf_reference=rf_reference(psid) if len(psid) == 17 else "",
        agency_code=agency, product_code=product_code,
        payer_id=payer["payer_id"] if payer else "", payer_account_id=payer_account_id,
        payer_name_snapshot=payer["name"] if payer else "UNIDENTIFIED",
        payer_id_masked=(payer["primary_id_type"] + " ****" + payer["primary_id_last4"]) if payer else "",
        external_ref=external_ref, description=f"{p['name']} - {tax_period}",
        currency="PKR", assessed_amount_minor=assessed, surcharge_accrued_minor=surcharge_minor,
        discount_applied_minor=discount_minor, payable_amount_minor=payable,
        allocated_amount_minor=0, balance_minor=payable,
        issue_date=issue.isoformat(), due_date=due.isoformat(), expiry_date=expiry,
        status="ISSUED", source=source, version=1,
        metadata=json.dumps(metadata or {}), waterfall=p["allocation_waterfall"]))
    return assessments[-1]

for _pidx, row in enumerate(PRODUCTS, start=101):
    (code, agency, name, category, scheme, amount_rule, partial, overpay, undertol, overtol,
     waterfall, channels, instruments, instr_policy, gating, headmap, seckeys, feebearer, dep) = row
    psid_product_code[code] = f"{_pidx:04d}"
    product_by_code[code] = dict(
        psid_product_code=f"{_pidx:04d}",
        product_code=code, agency_code=agency, name=name, category=category,
        reference_scheme_code=scheme, amount_rule=amount_rule,
        fixed_amount_minor=FIXED_AMOUNTS.get(code, ""), allow_partial=partial,
        overpay_treatment=overpay, underpay_tolerance_minor=undertol,
        overpay_tolerance_minor=overtol, allocation_waterfall=waterfall,
        allowed_channels=channels, allowed_instruments=instruments,
        instrument_credit_policy=instr_policy, service_gating=gating,
        head_mapping=headmap, secondary_lookup_keys=seckeys, fee_bearer=feebearer,
        deposit_refundable=dep,
        default_revenue_head_code=headmap["PRINCIPAL"], status="ACTIVE",
        effective_from="2026-07-01")

# --- Scenario A: company tax assessments (multi-head) ---
scenA = []
for i, c in enumerate(companies):
    principal = (350_000 + i * 47_500) * 100
    sur = int(principal * 0.014) // 100 * 100
    pen = (5_000 + i * 500) * 100 if i % 3 == 0 else 0
    scenA.append(add_assessment("FBR-IT-COMP", c, -45, -15, principal, sur, pen,
                                external_ref=f"DEMAND/IT/2026/{4100+i}",
                                metadata={"tax_year": "2025-26", "assessment_order": f"AO-{9100+i}"}))
for i, c in enumerate(companies[:10]):
    principal = (180_000 + i * 33_000) * 100
    scenA.append(add_assessment("FBR-ST-DOM", c, -20, -5, principal,
                                int(principal * 0.008) // 100 * 100,
                                external_ref=f"STR/2026/06/{7200+i}", tax_period="2026-06",
                                metadata={"return_period": "2026-06"}))
for i, c in enumerate(companies[:8]):
    principal = (95_000 + i * 21_000) * 100
    scenA.append(add_assessment("PRA-PST-SVC", c, -18, -3, principal,
                                external_ref=f"PRA/2026/06/{3300+i}", tax_period="2026-06"))
for i, c in enumerate(companies[:5]):
    principal = (140_000 + i * 26_000) * 100
    scenA.append(add_assessment("SRB-SST-SVC", c, -18, -3, principal,
                                external_ref=f"SRB/2026/06/{5500+i}", tax_period="2026-06"))
for i, c in enumerate(companies[:6]):
    principal = (620_000 + i * 88_000) * 100
    scenA.append(add_assessment("FBR-CUSTOMS", c, -2, 0, principal, fee_minor=(12_000 + i*900)*100,
                                external_ref=f"GD-KAPW-HC-{60100+i}", tax_period="2026-07",
                                metadata={"gd_no": f"KAPW-HC-{60100+i}", "psw_ref": f"PSW{880000+i}"},
                                expiry_offset=3))

# --- Scenario B: withholding tax challans for the bulk file ---
scenB = []
bulk_payer = companies[0]
for i in range(12):
    principal = (18_000 + i * 2_350) * 100
    scenB.append(add_assessment("FBR-WHT-153", bulk_payer, -6, 1, principal,
                                external_ref=f"WHT/153/2026/07/{9001+i}", tax_period="2026-07",
                                metadata={"vendor": f"Vendor {i+1}", "section": "153(1)(a)"}))

# --- Scenario C: token tax by vehicle (RtP + recurring) ---
scenC = []
for i, pa in enumerate([x for x in payer_accounts if x["agency_code"] == "ETPB"]):
    payer = next(p for p in payers if p["payer_id"] == pa["payer_id"])
    principal = (10_000 + (i % 4) * 2_500) * 100
    sur = (750 * (i % 3)) * 100
    scenC.append(add_assessment("ETPB-TOKEN-CAR", payer, -60, -30, principal, sur,
                                external_ref=f"TOKEN/2026-27/{pa['crn']}", tax_period="2026-27",
                                payer_account_id=pa["payer_account_id"],
                                metadata={"vehicle_reg": pa["crn"], "engine_cc": 1000 + (i % 4)*300}))

# --- Scenario D: traffic challans, incl. the LEA-17-1000 multi-payable demo ---
scenD = []
demo_vehicle = VEHICLES[0]  # LEA-17-1000
demo_payer = next(p for p in payers if p["payer_id"] == payer_accounts[0]["payer_id"])
scenD.append(add_assessment("PSCA-CHALLAN-MOV", demo_payer, -8, 7, 5_000_00, penalty_minor=0,
                            external_ref="CHL-PSCA-2026-0779123", tax_period="2026-07",
                            metadata={"vehicle_reg": demo_vehicle, "violation": "Over-speeding 78/60 km/h",
                                      "location": "Canal Road / Jail Road", "camera_id": "PSCA-CAM-0412"},
                            expiry_offset=90, discount_minor=1_250_00))
scenD.append(add_assessment("PSCA-CHALLAN-PARK", demo_payer, -40, -25, 2_000_00, penalty_minor=1_000_00,
                            external_ref="CHL-PSCA-2026-0611488", tax_period="2026-06",
                            metadata={"vehicle_reg": demo_vehicle, "violation": "No-parking zone",
                                      "location": "Liberty Market"}, expiry_offset=60))
for i, veh in enumerate(VEHICLES[1:14]):
    pa = next(x for x in payer_accounts if x.get("crn") == veh)
    payer = next(p for p in payers if p["payer_id"] == pa["payer_id"])
    prod = "PSCA-CHALLAN-MOV" if i % 2 == 0 else "PSCA-CHALLAN-PARK"
    pen = 1_000_00 if i % 3 == 0 else 0
    scenD.append(add_assessment(prod, payer, -12 - i, 2 + i, (2_000 + (i % 4) * 1_500) * 100,
                                penalty_minor=pen,
                                external_ref=f"CHL-PSCA-2026-0{700000+i*137}", tax_period="2026-07",
                                metadata={"vehicle_reg": veh, "violation": "Signal violation"},
                                expiry_offset=90))

# LEA-17-1000 also carries one OLD challan that was already paid, so the demo can
# show the ALREADY_SETTLED resolution response (which is what actually prevents
# most duplicate payments - see design section 8.2 / 14.5).
scenD_settled = add_assessment("PSCA-CHALLAN-PARK", demo_payer, -200, -185, 1_500_00,
                               external_ref="CHL-PSCA-2026-0455901", tax_period="2026-01",
                               metadata={"vehicle_reg": demo_vehicle, "violation": "No-parking zone",
                                         "location": "MM Alam Road"})

# A SECOND demo vehicle whose two challans are cleared together by one QR payment,
# so the "one payment, several payables" journey has its own anchor and does not
# consume the open payables the resolve demo depends on.
demo_vehicle2 = VEHICLES[2]
pa2 = next(x for x in payer_accounts if x.get("crn") == demo_vehicle2)
demo_payer2 = next(p for p in payers if p["payer_id"] == pa2["payer_id"])
scenD_qr = [
    add_assessment("PSCA-CHALLAN-MOV", demo_payer2, -30, -16, 5_000_00, penalty_minor=1_000_00,
                   external_ref="CHL-PSCA-2026-0688201", tax_period="2026-06",
                   metadata={"vehicle_reg": demo_vehicle2, "violation": "Red-light violation",
                             "location": "Ferozepur Road / Kalma Chowk"}, expiry_offset=60),
    add_assessment("PSCA-CHALLAN-PARK", demo_payer2, -20, -6, 2_000_00,
                   external_ref="CHL-PSCA-2026-0701455", tax_period="2026-07",
                   metadata={"vehicle_reg": demo_vehicle2, "violation": "Obstructive parking",
                             "location": "Gulberg Main Boulevard"}, expiry_offset=60),
]

# --- Scenario E: water bills with arrears (OLDEST_FIRST) ---
scenE = []
for i, pa in enumerate([x for x in payer_accounts if x["agency_code"] == "WASA"]):
    payer = next(p for p in payers if p["payer_id"] == pa["payer_id"])
    for k, per in enumerate(["2026-05", "2026-06", "2026-07"]):
        if i > 6 and k < 2:
            continue
        base = (1_450 + i * 120) * 100
        scenE.append(add_assessment("WASA-WATER-DOM", payer, -90 + k*30, -60 + k*30, base,
                                    surcharge_minor=(150 * (2 - k)) * 100 if k < 2 else 0,
                                    fee_minor=(320 + i*20)*100,
                                    external_ref=f"WASA/{pa['crn']}/{per}", tax_period=per,
                                    payer_account_id=pa["payer_account_id"],
                                    metadata={"crn": pa["crn"], "billing_period": per}))

# --- Scenario F: fees, stamps, deposits, court ---
scenF = []
for i, p in enumerate(individuals[:10]):
    scenF.append(add_assessment("NADRA-CNIC-FEE", p, -1, 6, 1_500_00,
                                external_ref=f"PP-2026-{8891200+i}", tax_period="2026-07",
                                metadata={"application_no": f"NAD-2026-{8891200+i}", "service": "CNIC Renewal"},
                                expiry_offset=7))
for i, p in enumerate(individuals[10:16]):
    principal = (145_000 + i * 30_000) * 100
    scenF.append(add_assessment("BOR-STAMP-DUTY", p, -1, 4, principal, fee_minor=(9_000 + i*800)*100,
                                external_ref=f"ESTAMP-PB-2026-{445000+i}", tax_period="2026-07",
                                metadata={"instrument_no": f"INS-2026-{445000+i}",
                                          "property": f"Plot {50+i}, DHA Phase 5, Lahore"},
                                expiry_offset=30))
for i, p in enumerate(individuals[16:21]):
    scenF.append(add_assessment("LHC-COURT-FEE", p, -1, 3, (15_000 + i * 5_000) * 100,
                                external_ref=f"CP-{1123+i}/2026", tax_period="2026-07",
                                metadata={"case_no": f"CP-{1123+i}/2026", "court": "Lahore High Court"},
                                expiry_offset=14))
for i, c in enumerate(companies[10:13]):
    scenF.append(add_assessment("BOR-TENDER-DEP", c, -3, 2, (500_000 + i * 250_000) * 100,
                                external_ref=f"TENDER/BOR/2026/{77+i}", tax_period="2026-07",
                                metadata={"tender_ref": f"BOR-T-2026-{77+i}", "refundable": True},
                                expiry_offset=10))
scenF.append(add_assessment("LHC-SEC-DEPOSIT", individuals[21], -2, 5, 250_000_00,
                            external_ref="CP-1199/2026-SEC", tax_period="2026-07",
                            metadata={"case_no": "CP-1199/2026", "refundable": True}, expiry_offset=20))
for i, c in enumerate(companies[5:11]):
    scenF.append(add_assessment("ETPB-PROF-TAX", c, -50, -20, (12_000 + i*3_000)*100,
                                surcharge_minor=(400 + i*100)*100,
                                external_ref=f"PROF/2026/{2200+i}", tax_period="2026-27"))
for i, pa in enumerate([x for x in payer_accounts if x["agency_code"] == "WASA"][:6]):
    payer = next(p for p in payers if p["payer_id"] == pa["payer_id"])
    scenF.append(add_assessment("ETPB-PROP-TAX", payer, -120, -60, (22_000 + i*5_500)*100,
                                surcharge_minor=(1_100 + i*300)*100,
                                external_ref=f"PT/LHR/2026/{6600+i}", tax_period="2026-27",
                                metadata={"property_id": f"MT-{1200+i}"}))
for i, p in enumerate(individuals[5:12]):
    scenF.append(add_assessment("FBR-IT-IND", p, -40, -10, (85_000 + i*17_000)*100,
                                surcharge_minor=(900 + i*220)*100,
                                external_ref=f"DEMAND/IT/IND/2026/{5500+i}",
                                metadata={"tax_year": "2025-26"}))
for i, p in enumerate(individuals[12:16]):
    scenF.append(add_assessment("ETPB-REG-NEW", p, 0, 5, (78_000 + i*12_000)*100,
                                external_ref=f"REG/NEW/2026/{3300+i}", tax_period="2026-07",
                                metadata={"chassis_no": f"NZE1210{45000+i}"}, expiry_offset=15))

by_id = {a["assessment_id"]: a for a in assessments}
lines_by_assessment = {}
for li in line_items:
    lines_by_assessment.setdefault(li["assessment_id"], []).append(li)

# ----------------------------------------------------------------------------
# Allocation engine (mirrors design doc section 11.3)
# ----------------------------------------------------------------------------
WATERFALL_ORDER = {
    "PENALTY_FIRST":   {"FEE":1,"PENALTY":2,"SURCHARGE":3,"INTEREST":4,"PRINCIPAL":5,"ROUNDING":9},
    "PRINCIPAL_FIRST": {"PRINCIPAL":1,"INTEREST":2,"SURCHARGE":3,"PENALTY":4,"FEE":5,"ROUNDING":9},
    "OLDEST_FIRST":    {"FEE":1,"PENALTY":2,"SURCHARGE":3,"INTEREST":4,"PRINCIPAL":5,"ROUNDING":9},
    "PRO_RATA":        {"FEE":1,"PENALTY":1,"SURCHARGE":1,"INTEREST":1,"PRINCIPAL":1,"ROUNDING":9},
    "EXPLICIT_ONLY":   {"FEE":1,"PENALTY":2,"SURCHARGE":3,"INTEREST":4,"PRINCIPAL":5,"ROUNDING":9},
}
allocations = []

def allocate(payment_id, targets, amount_minor, basis="WATERFALL"):
    """targets = list of assessment dicts, in the order the waterfall should walk them."""
    remaining = amount_minor
    made = []
    for a in targets:
        if remaining <= 0:
            break
        wf = a["waterfall"]
        order = WATERFALL_ORDER[wf]
        lis = sorted(lines_by_assessment[a["assessment_id"]],
                     key=lambda l: (order.get(l["line_type"], 9), l["seq"]))
        # OLDEST_FIRST: caller already sorted the assessments by tax_period
        # PRO_RATA: split proportionally across open lines, largest-remainder so
        # the parts sum back exactly to the amount applied (no lost paisa).
        prorata = {}
        if wf == "PRO_RATA":
            open_lines = [l for l in lis if l["amount_minor"] - l["allocated_minor"] > 0]
            open_total = sum(l["amount_minor"] - l["allocated_minor"] for l in open_lines)
            to_split = min(remaining, open_total)
            if open_total > 0:
                base, rema = {}, []
                for l in open_lines:
                    bal = l["amount_minor"] - l["allocated_minor"]
                    exact = to_split * bal
                    base[l["line_item_id"]] = exact // open_total
                    rema.append((exact % open_total, l["line_item_id"]))
                short = to_split - sum(base.values())
                for _, lid in sorted(rema, reverse=True)[:short]:
                    base[lid] += 1
                prorata = base
        for li in lis:
            if remaining <= 0:
                break
            bal = li["amount_minor"] - li["allocated_minor"]
            if bal <= 0:
                continue
            amt = min(bal, remaining)
            if wf == "PRO_RATA":
                amt = min(prorata.get(li["line_item_id"], 0), bal, remaining)
                if amt <= 0:
                    continue
            li["allocated_minor"] += amt
            remaining -= amt
            alloc = dict(
                allocation_id=f"AL-{len(allocations)+len(made)+1:06d}", payment_id=payment_id,
                assessment_id=a["assessment_id"], line_item_id=li["line_item_id"],
                revenue_head_code=li["revenue_head_code"], revenue_head_id=li["revenue_head_id"],
                amount_minor=amt, allocation_basis=basis, status="APPLIED",
                applied_at="", reversal_reason="")
            made.append(alloc)
        a["allocated_amount_minor"] = sum(l["allocated_minor"] for l in lines_by_assessment[a["assessment_id"]])
        a["balance_minor"] = a["payable_amount_minor"] - a["allocated_amount_minor"]
    allocations.extend(made)
    return made, remaining

def refresh_status(a):
    prod = product_by_code[a["product_code"]]
    tol = int(prod["underpay_tolerance_minor"])
    if a["allocated_amount_minor"] == 0:
        a["status"] = "OVERDUE" if date.fromisoformat(a["due_date"]) < TODAY else "ISSUED"
    elif a["balance_minor"] <= tol:
        a["status"] = "SETTLED"
    else:
        a["status"] = "PARTIALLY_PAID"

# ----------------------------------------------------------------------------
# Payments
# ----------------------------------------------------------------------------
payments = []
CHANNEL_RAIL = {
    "APP": "RAAST", "QR": "RAAST", "RTP": "RAAST", "IBANKING": "RAAST",
    "BILLER": "IBFT_1LINK", "ATM": "IBFT_1LINK", "AGENT": "IBFT_1LINK",
    "WALLET": "WALLET", "CARD": "PAYPAK", "OTC_CASH": "CASH",
    "CHEQUE": "CHEQUE_CLEARING", "API": "PRISM_RTGS",
}
pay_seq = 0
B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
def next_payment_ref():
    global pay_seq
    pay_seq += 1
    n = pay_seq
    s = ""
    for _ in range(5):
        s = B32[n % 32] + s
        n //= 32
    return "P26" + s

def cutoff_for(agency_code):
    return next(a[7] for a in AGENCIES if a[0] == agency_code)

def add_payment(channel, targets, amount_minor, day_offset=0, hour=11, minute=17,
                instrument_id="", finality="FINAL", status="CONFIRMED",
                basis="WATERFALL", remittance=None, bulk_batch_id="", rtp_ref="",
                fee_minor=0, agency_override=None, force_unapplied=False,
                payer=None, in_bank=True, in_switch=None, in_rail=None,
                third_party=None, allocate_now=True, e2e_override=None):
    global payments
    rail = CHANNEL_RAIL[channel]
    agency = agency_override or (targets[0]["agency_code"] if targets else "")
    ts = datetime(TODAY.year, TODAY.month, TODAY.day, hour, minute, 0,
                  tzinfo=timezone.utc) + timedelta(days=day_offset)
    obligation_date = (TODAY + timedelta(days=day_offset)).isoformat()
    cut = cutoff_for(agency) if agency else "18:00"
    cut_h, cut_m = int(cut[:2]), int(cut[3:5])
    if (hour, minute) > (cut_h, cut_m):
        vd = TODAY + timedelta(days=day_offset + 1)
        reason = "AFTER_CUTOFF"
    else:
        vd = TODAY + timedelta(days=day_offset)
        reason = "SAME_DAY"
    while vd.weekday() >= 5:
        vd += timedelta(days=1)
        reason = "NON_BUSINESS_DAY"
    ref = next_payment_ref()
    pid = f"PM-{len(payments)+1:05d}"
    e2e = e2e_override or f"E2E{ref}{len(payments):04d}"
    pay = dict(
        payment_id=pid, payment_reference=ref, intent_reference=f"I{ref}0",
        agency_code=agency, channel=channel, rail=rail, direction="INBOUND",
        instrument_id=instrument_id, bulk_batch_id=bulk_batch_id, rtp_reference=rtp_ref,
        gross_amount_minor=amount_minor, fee_amount_minor=fee_minor,
        net_to_agency_minor=amount_minor - (fee_minor if fee_minor and
                            product_by_code[targets[0]["product_code"]]["fee_bearer"] == "AGENCY" else 0)
                            if targets else amount_minor,
        unapplied_amount_minor=0, currency="PKR", status=status, finality=finality,
        value_date=vd.isoformat(), obligation_discharge_date=obligation_date,
        cutoff_reason=reason, cutoff_rule_version="CUTOFF-2026.07",
        received_at=ts.isoformat().replace("+00:00", "Z"),
        confirmed_at=ts.isoformat().replace("+00:00", "Z") if status == "CONFIRMED" else "",
        rail_e2e_id=e2e,
        rail_uetr="", switch_stan="", switch_rrn="", acquirer_id="",
        payer_account_masked="", payer_bank_bic="",
        remittance_raw=remittance or "", third_party_payer=json.dumps(third_party) if third_party else "",
        settlement_cycle="", duplicate_of_payment_reference="",
        in_bank_statement="Y" if in_bank else "N",
        in_switch_file="Y" if (in_switch if in_switch is not None
                               else rail in ("IBFT_1LINK", "PAYPAK")) else "N",
        in_rail_file="Y" if (in_rail if in_rail is not None else rail == "RAAST") else "N",
    )
    bank = random.choice(BANKS)
    pay["payer_bank_bic"] = bank[0]
    pay["payer_account_masked"] = "PK**" + "*" * 12 + f"{random.randint(1000, 9999)}"
    if rail in ("IBFT_1LINK", "PAYPAK"):
        pay["switch_stan"] = f"{random.randint(100000, 999999)}"
        pay["switch_rrn"] = f"{vd.strftime('%y%j')}{random.randint(100000, 999999)}"
        pay["acquirer_id"] = bank[0][:4] + "ACQ"
    if rail == "RAAST":
        pay["rail_uetr"] = f"{random.getrandbits(32):08x}-{random.getrandbits(16):04x}-4{random.getrandbits(12):03x}-8{random.getrandbits(12):03x}-{random.getrandbits(48):012x}"
        pay["settlement_cycle"] = f"RAAST-{vd.isoformat()}-C{min(6, max(1, hour // 4 + 1))}"
    payments.append(pay)

    if allocate_now and status == "CONFIRMED" and not force_unapplied and targets:
        made, remaining = allocate(pid, targets, amount_minor - (fee_minor if fee_minor and
                        product_by_code[targets[0]["product_code"]]["fee_bearer"] == "AGENCY" else 0),
                        basis=basis)
        for m in made:
            m["applied_at"] = pay["confirmed_at"]
        pay["unapplied_amount_minor"] = remaining
        for a in targets:
            refresh_status(a)
    elif force_unapplied:
        pay["unapplied_amount_minor"] = amount_minor
        pay["agency_code"] = ""
    return pay

DIGITAL = ["APP", "QR", "IBANKING", "BILLER", "ATM", "WALLET", "CARD", "AGENT", "API"]

# Reserve assessments for the specific exception scenarios BEFORE the bulk of
# straightforward payments consume them. Without this, the interesting demo
# paths (returned cheque, post-dated cheque, in-clearing cheque, overpayment)
# silently end up with no eligible target.
def pick(pool, code, n, skip=0):
    xs = [a for a in pool if a["product_code"] == code]
    return xs[skip:skip + n]

res_chq     = pick(scenA, "FBR-IT-COMP", 3)            # cheque covering 3 challans, clears
res_partial = pick(scenA, "FBR-IT-COMP", 6, skip=3)    # partial payments
res_ret     = pick(scenA, "FBR-ST-DOM", 3)             # THE returned cheque, 3 challans
res_cust    = pick(scenA, "FBR-CUSTOMS", 1)            # pay order, gate hold
res_dep     = pick(scenF, "BOR-TENDER-DEP", 1)         # demand draft, refundable deposit
res_pdc     = pick(scenF, "ETPB-PROF-TAX", 1)          # post-dated cheque, held
res_inc     = pick(scenF, "FBR-IT-IND", 1)             # cheque currently in clearing
res_over    = pick(scenF, "ETPB-PROP-TAX", 2)          # overpayments
# token tax overpayment: NOT the demo vehicle, whose payables must stay open
res_tokover = [a for a in scenC if demo_vehicle not in a["metadata"]][:1]
res_unc     = pick(scenF, "NADRA-CNIC-FEE", 1)         # UNCERTAIN payment
# Six token taxes held open so the RtP lifecycle demo has real targets for
# DELIVERED / PRESENTED / DECLINED / EXPIRED / ACCEPTED_FUTURE_DATED / CANCELLED.
res_rtp_open = [a for a in scenC if demo_vehicle not in a["metadata"]
                and a not in res_tokover][:6]
# Four more token taxes settled THROUGH the RtP channel, so the flagship journey has
# a payment-side anchor and the RTP channel is actually exercised (design doc 8.3 step 9:
# the fulfilling credit carries EndToEndId == rtp_reference).
res_rtp_fulfilled = [a for a in scenC if demo_vehicle not in a["metadata"]
                     and a not in res_tokover and a not in res_rtp_open][:4]
# LEA-17-1000: token tax + 2 live challans stay OPEN for the resolution demo
res_demo_open = [a for a in (scenC + scenD)
                 if demo_vehicle in a["metadata"] and a is not scenD_settled]
res_multi_payer = payer_accounts[len([x for x in payer_accounts
                                      if x['agency_code'] == 'ETPB'])]["payer_id"]
res_wasa_multi = sorted([a for a in scenE if a["payer_id"] == res_multi_payer],
                        key=lambda a: json.loads(a["metadata"]).get("billing_period", ""))

RESERVED = {a["assessment_id"] for grp in
            (res_chq, res_partial, res_ret, res_cust, res_dep, res_pdc, res_inc,
             res_over, res_tokover, res_unc, res_wasa_multi, scenB,
             res_demo_open, res_rtp_open, res_rtp_fulfilled, scenD_qr, [scenD_settled])
            for a in grp}

# --- F1. full payments across all channels -------------------------------
full_pay_pool = [a for a in (scenA + scenC + scenD[2:] + scenF)
                 if a["assessment_id"] not in RESERVED]
random.shuffle(full_pay_pool)
paid_full = full_pay_pool[:80]
for i, a in enumerate(paid_full):
    prod = product_by_code[a["product_code"]]
    allowed = [c for c in prod["allowed_channels"].split("|") if c in DIGITAL]
    ch = allowed[i % len(allowed)] if allowed else "APP"
    fee = 25_00 if prod["fee_bearer"] == "PAYER" else 0
    add_payment(ch, [a], a["payable_amount_minor"], day_offset=-(i % 4),
                hour=9 + (i % 9), minute=(i * 7) % 60, fee_minor=fee,
                remittance=f"PSID {a['psid']} {prod['name'][:20].upper()}")

# --- F1b. RtP-fulfilling payments (channel RTP, EndToEndId == rtp_reference) ---
# The RtP rows themselves are created further down; references are allocated in
# order, so RT-0001..RT-0004 become R260001..R260004.
rtp_fulfil_payment = {}
for i, a in enumerate(res_rtp_fulfilled, start=1):
    rtpref = f"R26{i:04d}"
    pay = add_payment("RTP", [a], a["payable_amount_minor"], day_offset=-(i % 3),
                      hour=10 + i, minute=(i * 9) % 60, rtp_ref=rtpref,
                      e2e_override=rtpref,
                      remittance=f"RAAST RTP {rtpref} PSID {a['psid']}")
    rtp_fulfil_payment[a["assessment_id"]] = pay

# --- F2. OTC cash payments ------------------------------------------------
otc_pool = [a for a in scenE if a["status"] in ("ISSUED", "OVERDUE")
            and a["assessment_id"] not in RESERVED][:10]
for i, a in enumerate(otc_pool):
    add_payment("OTC_CASH", [a], a["payable_amount_minor"], day_offset=-(i % 3),
                hour=10 + (i % 6), minute=(i * 11) % 60,
                remittance=f"CASH OTC {a['psid']}")

# --- F3. partial payments -------------------------------------------------
partial_pool = res_partial
for i, a in enumerate(partial_pool):
    part = int(a["payable_amount_minor"] * (0.4 + 0.1 * (i % 4)))
    part = part - (part % 100)
    add_payment("IBANKING", [a], part, day_offset=-(i % 3), hour=12, minute=(i*13) % 60,
                remittance=f"PART PAYMENT PSID {a['psid']}")

# --- F4. multi-bill payment: arrears, OLDEST_FIRST ------------------------
wasa_multi = [a for a in res_wasa_multi if a["status"] in ("ISSUED", "OVERDUE")]
if len(wasa_multi) >= 2:
    total = sum(a["payable_amount_minor"] for a in wasa_multi)
    add_payment("APP", wasa_multi, int(total * 0.72) - (int(total * 0.72) % 100),
                day_offset=-1, hour=15, minute=5,
                remittance=f"WASA ARREARS {wasa_multi[0]['psid']}")

# QR demo on the SECOND demo vehicle: both challans cleared by one scan,
# oldest first, explicit allocation.
demo_targets = [scenD_qr[0], scenD_qr[1]]
demo_total = sum(a["payable_amount_minor"] for a in demo_targets)
add_payment("QR", demo_targets, demo_total, day_offset=0, hour=14, minute=32,
            basis="EXPLICIT", fee_minor=25_00,
            remittance=f"QR CHALLAN {demo_targets[0]['psid']} {demo_targets[1]['psid']}")

# The already-settled old challan on LEA-17-1000 (drives ALREADY_SETTLED at resolve)
add_payment("ATM", [scenD_settled], scenD_settled["payable_amount_minor"], day_offset=-3,
            hour=12, minute=12, fee_minor=25_00,
            remittance=f"CHALLAN {scenD_settled['psid']}")

# --- F5. overpayments -----------------------------------------------------
for i, a in enumerate(res_over):
    add_payment("APP", [a], a["payable_amount_minor"] + (5_000 + i*2_500) * 100,
                day_offset=-1, hour=11, minute=40 + i,
                remittance=f"OVERPAY PSID {a['psid']}")
for a in res_tokover:
    add_payment("ATM", [a], a["payable_amount_minor"] + 300_00, day_offset=0, hour=13, minute=9,
                fee_minor=25_00, remittance=f"TOKEN TAX {a['psid']}")

# --- F6. bulk corporate file ---------------------------------------------
bulk_total = sum(a["payable_amount_minor"] for a in scenB)
add_payment("API", scenB, bulk_total, day_offset=-1, hour=16, minute=45,
            basis="EXPLICIT", bulk_batch_id="BULK-2026-07-29-0001",
            remittance="BULK WHT FILE BULK-2026-07-29-0001 12 CHALLANS")

# --- F7. cheques / instruments ------------------------------------------
instruments = []
def add_instrument(itype, number, drawee, amount_minor, targets, status, lodged_offset,
                   policy, present_offset=None, outcome_offset=None, return_reason="",
                   post_dated_date=""):
    iid = f"IN-{len(instruments)+1:04d}"
    instruments.append(dict(
        instrument_id=iid, instrument_type=itype, instrument_number=number,
        drawee_bank_bic=drawee[0], drawee_bank_name=drawee[1], drawee_branch_code=f"0{random.randint(100,999)}",
        drawer_name=targets[0]["payer_name_snapshot"] if targets else "",
        drawer_account_masked="PK**" + "*"*12 + f"{random.randint(1000,9999)}",
        instrument_date=post_dated_date or (TODAY + timedelta(days=lodged_offset)).isoformat(),
        amount_minor=amount_minor,
        lodged_at_branch="HBL-0142", lodged_by_user="teller.ahsan",
        teller_batch_id=f"TB-{(TODAY + timedelta(days=lodged_offset)).isoformat()}-01",
        linked_assessment_ids="|".join(a["assessment_id"] for a in targets),
        linked_psids="|".join(a["psid"] for a in targets),
        linked_amounts=json.dumps([{"psid": a["psid"], "amount_minor": a["payable_amount_minor"]}
                                   for a in targets]),
        status=status, instrument_credit_policy=policy,
        lodged_on=(TODAY + timedelta(days=lodged_offset)).isoformat(),
        presented_on=(TODAY + timedelta(days=present_offset)).isoformat() if present_offset is not None else "",
        clears_on_expected=(TODAY + timedelta(days=(present_offset or 0) + 2)).isoformat()
                            if present_offset is not None else "",
        cleared_on=(TODAY + timedelta(days=outcome_offset)).isoformat()
                    if outcome_offset is not None and status == "CLEARED" else "",
        returned_on=(TODAY + timedelta(days=outcome_offset)).isoformat()
                    if outcome_offset is not None and status == "RETURNED" else "",
        return_reason_code=return_reason,
        dishonour_charge_minor=500_00 if status == "RETURNED" else 0,
        provisional_credit_given="Y" if policy != "ON_CLEARING" else "N",
        image_front_uri=f"s3://nexuscollect-demo/cheques/{iid}-front.tif",
        image_back_uri=f"s3://nexuscollect-demo/cheques/{iid}-back.tif"))
    return instruments[-1]

# IN-0001: cheque covering THREE company income-tax challans, cleared
chq_targets = res_chq
chq_amount = sum(a["payable_amount_minor"] for a in chq_targets)
i1 = add_instrument("CHEQUE", "004821", BANKS[0], chq_amount, chq_targets, "CLEARED",
                    -4, "PROVISIONAL_ON_LODGEMENT", present_offset=-4, outcome_offset=-2)
add_payment("CHEQUE", chq_targets, chq_amount, day_offset=-2, hour=10, minute=5,
            instrument_id=i1["instrument_id"], basis="EXPLICIT",
            remittance=f"CHEQUE 004821 {i1['drawee_bank_name']} 3 CHALLANS")

# IN-0002: pay order for a customs GD, cleared, gate released
cust = res_cust
if cust:
    i2 = add_instrument("PAY_ORDER", "PO-778120", BANKS[2], cust[0]["payable_amount_minor"],
                        cust, "CLEARED", -3, "PROVISIONAL_WITH_GATE_HOLD",
                        present_offset=-3, outcome_offset=-2)
    add_payment("CHEQUE", cust, cust[0]["payable_amount_minor"], day_offset=-2, hour=11, minute=20,
                instrument_id=i2["instrument_id"], basis="EXPLICIT",
                remittance="PAY ORDER PO-778120 CUSTOMS DUTY")

# IN-0003: demand draft for a tender deposit, cleared
dep = res_dep
if dep:
    i3 = add_instrument("DEMAND_DRAFT", "DD-991204", BANKS[4], dep[0]["payable_amount_minor"],
                        dep, "CLEARED", -3, "ON_CLEARING", present_offset=-3, outcome_offset=-1)
    add_payment("CHEQUE", dep, dep[0]["payable_amount_minor"], day_offset=-1, hour=12, minute=0,
                instrument_id=i3["instrument_id"], basis="EXPLICIT",
                remittance="DD-991204 TENDER SECURITY BOR-T-2026-77")

# IN-0004: THE RETURNED CHEQUE. Provisional credit given, then dishonoured.
ret_targets = res_ret
ret_amount = sum(a["payable_amount_minor"] for a in ret_targets)
i4 = add_instrument("CHEQUE", "004822", BANKS[1], ret_amount, ret_targets, "RETURNED",
                    -3, "PROVISIONAL_ON_LODGEMENT", present_offset=-3, outcome_offset=-1,
                    return_reason="INSUFFICIENT_FUNDS")
ret_pay = add_payment("CHEQUE", ret_targets, ret_amount, day_offset=-3, hour=10, minute=45,
                      instrument_id=i4["instrument_id"], basis="EXPLICIT",
                      finality="PROVISIONAL", remittance="CHEQUE 004822 SALES TAX 3 RETURNS",
                      in_bank=False)
# reverse it
for al in allocations:
    if al["payment_id"] == ret_pay["payment_id"]:
        al["status"] = "REVERSED"
        al["reversal_reason"] = "CHEQUE_RETURNED"
        li = next(l for l in line_items if l["line_item_id"] == al["line_item_id"])
        li["allocated_minor"] -= al["amount_minor"]
ret_pay["status"] = "REVERSED"
ret_pay["unapplied_amount_minor"] = 0
for a in ret_targets:
    a["allocated_amount_minor"] = sum(l["allocated_minor"] for l in lines_by_assessment[a["assessment_id"]])
    a["balance_minor"] = a["payable_amount_minor"] - a["allocated_amount_minor"]
    refresh_status(a)
# dishonour charge assessment
dishon_payer = next(p for p in payers if p["payer_id"] == ret_targets[0]["payer_id"])
dishon = add_assessment("FBR-DISHON-CHG", dishon_payer, 0, 14, 500_00,
                        external_ref=f"DISHON/{i4['instrument_number']}", tax_period="2026-07",
                        metadata={"instrument_id": i4["instrument_id"],
                                  "return_reason": "INSUFFICIENT_FUNDS",
                                  "original_amount_minor": ret_amount}, expiry_offset=30)
lines_by_assessment.setdefault(dishon["assessment_id"], [l for l in line_items
                               if l["assessment_id"] == dishon["assessment_id"]])
by_id[dishon["assessment_id"]] = dishon

# IN-0005: post-dated cheque, held
pdc_targets = res_pdc
if pdc_targets:
    add_instrument("POST_DATED_CHEQUE", "004823", BANKS[3], pdc_targets[0]["payable_amount_minor"],
                   pdc_targets, "HELD_POST_DATED", -1, "ON_CLEARING",
                   post_dated_date=(TODAY + timedelta(days=12)).isoformat())

# IN-0006: cheque in clearing right now
inc_targets = res_inc
if inc_targets:
    add_instrument("CHEQUE", "004824", BANKS[5], inc_targets[0]["payable_amount_minor"],
                   inc_targets, "IN_CLEARING", 0, "ON_CLEARING", present_offset=0)

# --- F8. unapplied receipts (2) -----------------------------------------
unapp1 = add_payment("API", [], 47_500_00, day_offset=0, hour=11, minute=3,
                     agency_override="", force_unapplied=True, in_bank=True, in_rail=False,
                     remittance="TOKEN TAX LEA 17 1000 PAYMENT AHMED", allocate_now=False)
unapp2 = add_payment("API", [], 125_000_00, day_offset=-14, hour=9, minute=51,
                     agency_override="", force_unapplied=True, in_bank=True, in_rail=False,
                     remittance="TAX PAYMENT AHMED", allocate_now=False)

# --- F9. an UNCERTAIN payment -------------------------------------------
unc_target = res_unc
if unc_target:
    add_payment("BILLER", unc_target, unc_target[0]["payable_amount_minor"], day_offset=0,
                hour=17, minute=58, status="UNCERTAIN", allocate_now=False,
                in_bank=False, in_switch=True,
                remittance=f"BILLER TIMEOUT {unc_target[0]['psid']}")

# --- F10. a duplicate payment -------------------------------------------
dup_src = next((p for p in payments if p["status"] == "CONFIRMED" and p["channel"] == "APP"
                and p["gross_amount_minor"] > 100_000_00), None)
if dup_src:
    dup = add_payment("APP", [], dup_src["gross_amount_minor"], day_offset=0, hour=14, minute=41,
                      agency_override=dup_src["agency_code"], force_unapplied=True,
                      allocate_now=False, remittance=dup_src["remittance_raw"])
    dup["duplicate_of_payment_reference"] = dup_src["payment_reference"]
    dup["agency_code"] = dup_src["agency_code"]

for a in assessments:
    refresh_status(a)
    if a["status"] in ("ISSUED", "OVERDUE") and a["expiry_date"] and \
       date.fromisoformat(a["expiry_date"]) < TODAY:
        a["status"] = "EXPIRED"

# ----------------------------------------------------------------------------
# Requests to Pay
# ----------------------------------------------------------------------------
rtps = []
def add_rtp(targets, alias, status, expires_offset, created_offset, modifiable=False,
            decline_reason="", fulfilling_ref="", reminders=0):
    rid = f"RT-{len(rtps)+1:04d}"
    amt = sum(a["payable_amount_minor"] for a in targets)
    payer = next((p for p in payers if p["payer_id"] == targets[0]["payer_id"]), None)
    rtps.append(dict(
        rtp_id=rid, rtp_reference=f"R26{rid[-4:]}", agency_code=targets[0]["agency_code"],
        assessment_ids="|".join(a["assessment_id"] for a in targets),
        psids="|".join(a["psid"] for a in targets),
        payer_id=targets[0]["payer_id"], payer_alias_type="MSISDN", payer_alias_value=alias,
        resolved_payer_iban="PK" + str(random.randint(10, 99)) + "HABB" + str(random.randint(10**14, 10**15 - 1)),
        resolved_payer_bank_bic=random.choice(BANKS)[0],
        amount_minor=amt, amount_modifiable="Y" if modifiable else "N",
        requested_execution_date=(TODAY + timedelta(days=expires_offset)).isoformat(),
        expires_at=(datetime(TODAY.year, TODAY.month, TODAY.day, 23, 59,
                    tzinfo=timezone.utc) + timedelta(days=expires_offset)).isoformat().replace("+00:00","Z"),
        created_at=(datetime(TODAY.year, TODAY.month, TODAY.day, 9, 0,
                    tzinfo=timezone.utc) + timedelta(days=created_offset)).isoformat().replace("+00:00","Z"),
        status=status, decline_reason_code=decline_reason,
        rail_msg_id=f"PAIN013-{rid}", rail_status_msg_id=f"PAIN014-{rid}",
        fulfilling_payment_reference=fulfilling_ref, reminder_count=reminders,
        payer_name=payer["name"] if payer else "", raast_id_expires_on=payer["raast_id_expires_on"] if payer else ""))
    return rtps[-1]

for a in res_rtp_fulfilled:
    payer = next(p for p in payers if p["payer_id"] == a["payer_id"])
    pay = rtp_fulfil_payment[a["assessment_id"]]
    add_rtp([a], payer["raast_id_value"], "FULFILLED", -1, -3,
            fulfilling_ref=pay["payment_reference"])
tok_open = res_rtp_open
statuses = [("DELIVERED", "", 5, -1, 0), ("PRESENTED", "", 4, -1, 0),
            ("DECLINED", "AM04_INSUFFICIENT_FUNDS", -1, -6, 0),
            ("EXPIRED", "", -2, -9, 1), ("ACCEPTED_FUTURE_DATED", "", 6, -1, 0),
            ("CANCELLED", "AGENCY_WITHDRAWN", 3, -2, 0)]
for (a, (st, dr, eo, co, rem)) in zip(tok_open, statuses):
    payer = next(p for p in payers if p["payer_id"] == a["payer_id"])
    add_rtp([a], payer["raast_id_value"], st, eo, co, decline_reason=dr, reminders=rem)
# bulk RtP campaign rows for property tax
prop_open = [a for a in scenF if a["product_code"] == "ETPB-PROP-TAX"][:3]
for a in prop_open:
    payer = next(p for p in payers if p["payer_id"] == a["payer_id"])
    r = add_rtp([a], payer["raast_id_value"], "DELIVERED", 7, 0, modifiable=True)
    r["bulk_batch_id"] = "RTPB-2026-07-30-PROPTAX"
# an alias-expired RtP
exp_alias_payer = next(p for p in payers if p["raast_id_expires_on"] == "2026-06-30")
exp_targets = [a for a in assessments if a["payer_id"] == exp_alias_payer["payer_id"]][:1]
if exp_targets:
    add_rtp(exp_targets, exp_alias_payer["raast_id_value"], "UNDELIVERABLE", 3, -1,
            decline_reason="ALIAS_EXPIRED")

# ----------------------------------------------------------------------------
# RECONCILIATION SOURCES + planted breaks
# ----------------------------------------------------------------------------
RECON_DATE = TODAY.isoformat()          # 2026-07-30
confirmed = [p for p in payments if p["status"] == "CONFIRMED"]
on_date = [p for p in confirmed if p["value_date"] == RECON_DATE]

planted = []

# --- Bank statement (camt.053) ------------------------------------------
bank_rows, bank_seq = [], 0
def bank_row(p, amount=None, value_date=None, narrative=None, entry_ref=None):
    global bank_seq
    bank_seq += 1
    return dict(
        statement_id=f"CAMT053-HBL-{RECON_DATE}", account_iban="PK36HABB0000009988776655",
        entry_seq=bank_seq, entry_reference=entry_ref or f"HBL{RECON_DATE.replace('-','')}{bank_seq:05d}",
        booking_date=value_date or p["value_date"], value_date=value_date or p["value_date"],
        credit_debit="CRDT", amount_minor=amount if amount is not None else p["gross_amount_minor"],
        currency="PKR", end_to_end_id=p["rail_e2e_id"] if p else "",
        uetr=p["rail_uetr"] if p else "", bank_reference=f"BREF{bank_seq:07d}",
        remittance_information=narrative if narrative is not None else p["remittance_raw"],
        debtor_name="", debtor_bic=p["payer_bank_bic"] if p else "", rail=p["rail"] if p else "")

# The bank statement covers the whole 5-business-day window so the file is a
# realistic size; the planted breaks are all placed on the 2026-07-30
# population, which is the date the demo reconciles.
bank_candidates = [p for p in confirmed if p["in_bank_statement"] == "Y"]
break_pool = [p for p in bank_candidates if p["value_date"] == RECON_DATE]
# B02: one platform payment missing from the bank
b02_victim = next(p for p in break_pool if p["rail"] == "RAAST"
                  and p["gross_amount_minor"] > 50_000_00)
# B05 x2: two payments appear in the bank one day later
b05_victims = [p for p in break_pool if p is not b02_victim][:2]
# B03: amount mismatch (bank credit 5,000 paisa short)
b03_victim = next(p for p in break_pool
                  if p not in b05_victims and p is not b02_victim and p["rail"] == "IBFT_1LINK")
# B02's victim must NOT claim to be in the bank statement - the absence IS the break.
b02_victim["in_bank_statement"] = "N"
B03_DELTA = 5_000     # paisa

for p in bank_candidates:
    if p is b02_victim:
        continue
    if p in b05_victims:
        nxt = (date.fromisoformat(p["value_date"]) + timedelta(days=1)).isoformat()
        bank_rows.append(bank_row(p, value_date=nxt))
        continue
    if p is b03_victim:
        bank_rows.append(bank_row(p, amount=p["gross_amount_minor"] - B03_DELTA))
        continue
    bank_rows.append(bank_row(p))

# B01 x2: unmatched credits in the bank with no platform payment
b01_a = dict(amount=47_500_00, narrative="TOKEN TAX LEA 17 1000 PAYMENT AHMED",
             ref="HBL20260730UNK01")
b01_b = dict(amount=125_000_00, narrative="TAX PAYMENT AHMED", ref="HBL20260730UNK02")
for extra in (b01_a, b01_b):
    bank_seq += 1
    bank_rows.append(dict(
        statement_id=f"CAMT053-HBL-{RECON_DATE}", account_iban="PK36HABB0000009988776655",
        entry_seq=bank_seq, entry_reference=extra["ref"], booking_date=RECON_DATE,
        value_date=RECON_DATE, credit_debit="CRDT", amount_minor=extra["amount"],
        currency="PKR", end_to_end_id="", uetr="", bank_reference=f"BREF{bank_seq:07d}",
        remittance_information=extra["narrative"], debtor_name="AHMED",
        debtor_bic="UNILPKKA", rail="PRISM_RTGS"))

# --- 1LINK switch settlement file ---------------------------------------
switch_rows = []
# Include the UNCERTAIN payment: the switch says it happened, the platform does not
# yet know. That asymmetry is the whole point of the UNCERTAIN state (section 9.4).
switch_pay = [p for p in payments
              if p["rail"] in ("IBFT_1LINK", "PAYPAK")
              and p["status"] in ("CONFIRMED", "UNCERTAIN")]
switch_pay_on_date = [p for p in switch_pay if p["value_date"] == RECON_DATE]
def switch_row(p, amount=None, fee=None):
    contracted_fee = 1_000     # paisa, contracted switch fee
    return dict(
        settlement_file=f"1LINK-STL-{RECON_DATE}", acquirer_id=p["acquirer_id"],
        stan=p["switch_stan"], rrn=p["switch_rrn"], txn_date=p["value_date"],
        txn_time=p["received_at"][11:19], biller_id="NEXUSCOLLECT",
        consumer_number=p["remittance_raw"].split()[-1] if p["remittance_raw"] else "",
        transaction_amount_minor=amount if amount is not None else p["gross_amount_minor"],
        switch_fee_minor=fee if fee is not None else contracted_fee,
        response_code="00", channel=p["channel"],
        end_to_end_id=p["rail_e2e_id"], payment_reference=p["payment_reference"])

# B07: fee variance on one row. MUST be a different payment from b03_victim,
# otherwise the b03 branch in the emit loop below swallows the fee variance and
# the break never appears in the file.
b07_victim = next((p for p in switch_pay_on_date if p is not b03_victim), None)
# B04: duplicate row in the switch file
b04_victim = next((p for p in switch_pay_on_date
                   if p is not b07_victim and p is not b03_victim), None)
assert b07_victim is not None and b07_victim is not b03_victim, "B07 victim collides with B03"
assert b04_victim is not None and b04_victim not in (b03_victim, b07_victim), "B04 victim collides"
for p in switch_pay:
    if p is b03_victim:
        switch_rows.append(switch_row(p, amount=p["gross_amount_minor"] - B03_DELTA))
        continue
    if p is b07_victim:
        switch_rows.append(switch_row(p, fee=1_750))     # contracted 1,000 paisa
        continue
    switch_rows.append(switch_row(p))
if b04_victim:
    switch_rows.append(switch_row(b04_victim))            # deliberate duplicate

# --- Raast cycle settlement file ----------------------------------------
raast_pay = [p for p in confirmed if p["rail"] == "RAAST"]
cycles = {}
for p in raast_pay:
    cycles.setdefault(p["settlement_cycle"], []).append(p)
rail_rows = []
B08_DELTA = 0
b08_cycle = None
on_date_cycles = sorted(k for k in cycles if RECON_DATE in k)
cycle_keys = sorted(cycles.keys())
if on_date_cycles:
    # plant the shortfall on the busiest cycle of the reconciliation date
    b08_cycle = max(on_date_cycles, key=lambda k: len(cycles[k]))
for ck in cycle_keys:
    ps = cycles[ck]
    txn_sum = sum(p["gross_amount_minor"] for p in ps if p is not b02_victim) \
              + (b02_victim["gross_amount_minor"] if b02_victim in ps else 0)
    declared = txn_sum
    if ck == b08_cycle:
        B08_DELTA = 12_500_00                              # cycle net understated
        declared = txn_sum - B08_DELTA
    for p in ps:
        rail_rows.append(dict(
            settlement_file=f"RAAST-STL-{RECON_DATE}", cycle_id=ck,
            cycle_cutoff=ck.split("-C")[-1], business_date=p["value_date"],
            participant_bic="NEXUSPKK", counterparty_bic=p["payer_bank_bic"],
            end_to_end_id=p["rail_e2e_id"], uetr=p["rail_uetr"],
            message_type="pacs.008", amount_minor=p["gross_amount_minor"],
            currency="PKR", status="ACSC",
            cycle_declared_net_minor=declared, cycle_txn_count=len(ps),
            payment_reference=p["payment_reference"]))

# --- Scroll + treasury ack (B09) ----------------------------------------
alloc_applied = [al for al in allocations if al["status"] == "APPLIED"]
pay_by_id = {p["payment_id"]: p for p in payments}
scroll_lines = []
for al in alloc_applied:
    p = pay_by_id[al["payment_id"]]
    if p["value_date"] != RECON_DATE or p["agency_code"] != "FBR":
        continue
    a = by_id[al["assessment_id"]]
    li = next(l for l in line_items if l["line_item_id"] == al["line_item_id"])
    scroll_lines.append(dict(
        line_no=len(scroll_lines) + 1, revenue_head_code=al["revenue_head_code"],
        psid=a["psid"], payer_name=a["payer_name_snapshot"], payer_id_masked=a["payer_id_masked"],
        tax_period=li["tax_period"], amount_minor=al["amount_minor"],
        payment_reference=p["payment_reference"],
        receipt_no=f"{p['agency_code']}{p['value_date'].replace('-','')}"
                   f"{(len(scroll_lines)+1)*37+120000:09d}",
        channel=p["channel"], rail=p["rail"], value_date=p["value_date"],
        instrument_type=(next((i["instrument_type"] for i in instruments
                               if i["instrument_id"] == p["instrument_id"]), "")
                         if p["instrument_id"] else ""),
        instrument_number=(next((i["instrument_number"] for i in instruments
                                 if i["instrument_id"] == p["instrument_id"]), "")
                           if p["instrument_id"] else ""),
        collecting_branch="HBL-0142" if p["instrument_id"] or p["channel"] == "OTC_CASH" else "",
        ack_status="ACCEPTED", ack_reason=""))
b09_line = None
for sl in scroll_lines:
    if sl["revenue_head_code"] == "B02391":     # penalty head - reject one
        sl["ack_status"] = "REJECTED"
        sl["ack_reason"] = "HEAD_NOT_VALID_FOR_PERIOD"
        b09_line = sl
        break
if b09_line is None and scroll_lines:
    scroll_lines[-1]["ack_status"] = "REJECTED"
    scroll_lines[-1]["ack_reason"] = "HEAD_NOT_VALID_FOR_PERIOD"
    b09_line = scroll_lines[-1]

# --- B06: aged unapplied receipt ---------------------------------------
b06_victim = unapp2   # received 14 days ago, still unapplied

# ----------------------------------------------------------------------------
# Planted-break manifest
# ----------------------------------------------------------------------------
planted = [
 dict(break_code="B01", type="UNMATCHED_CREDIT_IN_BANK", count=1,
      amount_minor=b01_a["amount"], source_ref=b01_a["ref"],
      narrative=b01_a["narrative"], expected_severity="MEDIUM",
      expected_resolution="Narrative resolvable: vehicle LEA-17-1000 -> token tax assessment. "
                          "Analyst proposes MANUAL allocation; approver approves.",
      auto_resolvable=False),
 dict(break_code="B01", type="UNMATCHED_CREDIT_IN_BANK", count=1,
      amount_minor=b01_b["amount"], source_ref=b01_b["ref"],
      narrative=b01_b["narrative"], expected_severity="HIGH",
      expected_resolution="Not resolvable from narrative. Remains unapplied, aged, "
                          "escalated per SLA; candidate for return to remitter.",
      auto_resolvable=False),
 dict(break_code="B02", type="UNMATCHED_PAYMENT_IN_PLATFORM", count=1,
      amount_minor=b02_victim["gross_amount_minor"],
      source_ref=b02_victim["payment_reference"], narrative=b02_victim["remittance_raw"],
      expected_severity="HIGH",
      expected_resolution="Present in Raast cycle file but absent from bank statement. "
                          "Verify with rail (pacs.028). Expect late credit or reversal.",
      auto_resolvable=False),
 dict(break_code="B03", type="AMOUNT_MISMATCH", count=1, amount_minor=B03_DELTA,
      source_ref=b03_victim["payment_reference"],
      narrative="Bank and switch both show gross less 50.00 PKR",
      expected_severity="LOW",
      expected_resolution="Fee deducted at source. Post fee variance; below auto-write-off "
                          "threshold only if configured >= 5000 paisa, else manual adjust.",
      auto_resolvable=False),
 dict(break_code="B04", type="DUPLICATE_IN_SOURCE", count=1,
      amount_minor=b04_victim["gross_amount_minor"] if b04_victim else 0,
      source_ref=f"STAN {b04_victim['switch_stan']} / RRN {b04_victim['switch_rrn']}" if b04_victim else "",
      narrative="Identical STAN/RRN appears twice in the 1LINK settlement file",
      expected_severity="LOW",
      expected_resolution="Auto-suppress the byte-identical duplicate (rule R6); retain evidence.",
      auto_resolvable=True),
 dict(break_code="B05", type="TIMING_DIFFERENCE", count=1,
      amount_minor=b05_victims[0]["gross_amount_minor"],
      source_ref=b05_victims[0]["payment_reference"],
      narrative="Platform value date 2026-07-30, bank booking 2026-07-31",
      expected_severity="INFO",
      expected_resolution="Auto-resolves on the next run (rule R1). Must not alarm.",
      auto_resolvable=True),
 dict(break_code="B05", type="TIMING_DIFFERENCE", count=1,
      amount_minor=b05_victims[1]["gross_amount_minor"],
      source_ref=b05_victims[1]["payment_reference"],
      narrative="Platform value date 2026-07-30, bank booking 2026-07-31",
      expected_severity="INFO",
      expected_resolution="Auto-resolves on the next run (rule R1). Must not alarm.",
      auto_resolvable=True),
 dict(break_code="B06", type="UNAPPLIED_RECEIPT_AGED", count=1,
      amount_minor=b06_victim["gross_amount_minor"],
      source_ref=b06_victim["payment_reference"], narrative=b06_victim["remittance_raw"],
      expected_severity="HIGH",
      expected_resolution="Aged 14 days. Escalate; propose return to remitter or transfer "
                          "to unclaimed funds per policy. Never to income.",
      auto_resolvable=False),
 dict(break_code="B07", type="FEE_VARIANCE", count=1, amount_minor=750,
      source_ref=b07_victim["payment_reference"] if b07_victim else "",
      narrative="Switch fee 17.50 PKR vs contracted 10.00 PKR",
      expected_severity="LOW",
      expected_resolution="Recompute against the rate card; raise with 1LINK; post fee variance.",
      auto_resolvable=False),
 dict(break_code="B08", type="SETTLEMENT_SHORTFALL", count=1, amount_minor=B08_DELTA,
      source_ref=b08_cycle or "",
      narrative="Raast cycle declared net is 125,000.00 PKR below the sum of its constituents",
      expected_severity="CRITICAL",
      expected_resolution="Reconcile at transaction level within the cycle; one CYCLE_VARIANCE "
                          "break, not one per transaction.",
      auto_resolvable=False),
 dict(break_code="B09", type="SCROLL_REJECTED", count=1,
      amount_minor=b09_line["amount_minor"] if b09_line else 0,
      source_ref=f"Scroll line {b09_line['line_no']} head {b09_line['revenue_head_code']}" if b09_line else "",
      narrative="Treasury ack: HEAD_NOT_VALID_FOR_PERIOD",
      expected_severity="MEDIUM",
      expected_resolution="Classification break, not a cash break. Reclassify head, "
                          "issue supplementary scroll. Never edit and resend the original.",
      auto_resolvable=False),
]

# ----------------------------------------------------------------------------
# QR payloads (EMVCo merchant-presented mode)
# ----------------------------------------------------------------------------
def build_qr(psid, amount_minor, agency_name, city, dynamic=True, ref_label="",
             corrupt_crc=False):
    s = tlv("00", "01") + tlv("01", "12" if dynamic else "11")
    s += tlv("26", tlv("00", "PK.RAAST") + tlv("01", "NEXUSCOLLECT") +
                    tlv("02", psid[:2] if psid else "00"))
    s += tlv("52", "9311") + tlv("53", "586")
    if amount_minor:
        s += tlv("54", f"{amount_minor/100:.2f}")
    s += tlv("58", "PK") + tlv("59", agency_name[:25]) + tlv("60", city[:15])
    add = ""
    if psid:
        add += tlv("01", psid)
    if ref_label:
        add += tlv("05", ref_label)
    add += tlv("07", "AGENCY-CTR-01")
    if add:
        s += tlv("62", add)
    s += "6304"
    crc = crc16_ccitt_false(s.encode("ascii"))
    if corrupt_crc:
        crc = (crc ^ 0x00FF) & 0xFFFF
    return s + f"{crc:04X}"

qr_samples = []
qr_a = next(a for a in scenD if a["product_code"] == "PSCA-CHALLAN-MOV")
qr_samples.append(dict(
    name="dynamic_with_amount", description="Dynamic merchant-presented QR on a printed e-challan",
    psid=qr_a["psid"], amount_minor=qr_a["payable_amount_minor"], valid=True,
    payload=build_qr(qr_a["psid"], qr_a["payable_amount_minor"],
                     "PUNJAB SAFE CITIES AUTH", "LAHORE", True, "CHL-0779123")))
qr_b = next(a for a in scenF if a["product_code"] == "BOR-STAMP-DUTY")
qr_samples.append(dict(
    name="dynamic_open_amount",
    description="Dynamic QR, amount omitted (payer enters; resolved amount is authoritative)",
    psid=qr_b["psid"], amount_minor=None, valid=True,
    payload=build_qr(qr_b["psid"], 0, "BOARD OF REVENUE PUNJAB", "LAHORE", True)))
qr_samples.append(dict(
    name="static_counter", description="Static counter QR: no PSID, no amount. Fallback only.",
    psid=None, amount_minor=None, valid=True,
    payload=build_qr("", 0, "LAHORE HIGH COURT", "LAHORE", False)))
qr_samples.append(dict(
    name="corrupted_crc", description="Deliberately corrupted CRC. Must be rejected with QR_CRC_INVALID.",
    psid=qr_a["psid"], amount_minor=qr_a["payable_amount_minor"], valid=False,
    payload=build_qr(qr_a["psid"], qr_a["payable_amount_minor"],
                     "PUNJAB SAFE CITIES AUTH", "LAHORE", True, "CHL-0779123",
                     corrupt_crc=True)))

# ----------------------------------------------------------------------------
# WRITE FILES
# ----------------------------------------------------------------------------
# ---- bulk payment input file (13 rows: 12 valid + 1 deliberately bad) --------
# Exercises the pre-validation path in design doc section 8.10: the whole file is
# validated before any of it is accepted, and one row references a PSID that has
# already been settled, so the file must be rejected with REJECT_ALL.
already_settled_psid = next(a["psid"] for a in assessments if a["status"] == "SETTLED")
bulk_input = []
for i, a in enumerate(scenB, start=1):
    bulk_input.append(dict(row_no=i, psid=a["psid"], amount_minor=a["payable_amount_minor"],
                           vendor_name=json.loads(a["metadata"]).get("vendor", ""),
                           section="153(1)(a)", tax_period="2026-07",
                           expected_outcome="VALID", expected_error_code=""))
bulk_input.append(dict(row_no=13, psid=already_settled_psid, amount_minor=2_500_00,
                       vendor_name="Vendor 13 (duplicate submission)", section="153(1)(a)",
                       tax_period="2026-07", expected_outcome="INVALID",
                       expected_error_code="ALREADY_SETTLED"))
bulk_declared_total = sum(r["amount_minor"] for r in bulk_input)


def write_csv(name, rows, fields=None):
    if not rows:
        return
    fields = fields or list(rows[0].keys())
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)

write_csv("agencies.csv", [dict(
    agency_code=a[0], name=a[1], tier=a[2], jurisdiction=a[3], settlement_model=a[4],
    treasury_account_iban=a[5], treasury_bank_bic=a[6], default_cutoff_time=a[7],
    timezone="Asia/Karachi", fiscal_year_start_month=7, status="ACTIVE") for a in AGENCIES])

write_csv("reference_schemes.csv", [dict(
    scheme_code=s[0], agency_code=s[1], total_length=s[2], prefix=s[3], checksum_algo=s[4],
    sequence_digits=s[5], random_digits=s[6], is_platform_minted="Y" if s[7] else "N",
    charset="NUMERIC", pattern_regex=f"^{s[3]}[0-9]{{{s[2]-len(s[3])}}}$",
    collision_policy="REJECT_AMBIGUOUS", notes=s[8]) for s in REFERENCE_SCHEMES])

write_csv("revenue_heads.csv", [dict(
    revenue_head_id=head_id[(h[0], h[1])], agency_code=h[0], code=h[1], name=h[2],
    fund=h[3], object_class=h[4], is_refundable_deposit="Y" if h[5] else "N",
    effective_from="2026-07-01", effective_to="") for h in REVENUE_HEADS])

write_csv("products.csv", [dict(
    product_code=p["product_code"], agency_code=p["agency_code"], name=p["name"],
    category=p["category"], reference_scheme_code=p["reference_scheme_code"],
    amount_rule=p["amount_rule"], fixed_amount_minor=p["fixed_amount_minor"],
    allow_partial="Y" if p["allow_partial"] else "N", overpay_treatment=p["overpay_treatment"],
    underpay_tolerance_minor=p["underpay_tolerance_minor"],
    overpay_tolerance_minor=p["overpay_tolerance_minor"],
    allocation_waterfall=p["allocation_waterfall"], allowed_channels=p["allowed_channels"],
    allowed_instruments=p["allowed_instruments"],
    instrument_credit_policy=p["instrument_credit_policy"], service_gating=p["service_gating"],
    fee_bearer=p["fee_bearer"], deposit_refundable="Y" if p["deposit_refundable"] else "N",
    default_revenue_head_code=p["default_revenue_head_code"],
    head_mapping=json.dumps(p["head_mapping"]),
    secondary_lookup_keys=json.dumps(p["secondary_lookup_keys"]),
    status=p["status"], effective_from=p["effective_from"]) for p in product_by_code.values()])

write_csv("payers.csv", payers)
write_csv("payer_accounts.csv", payer_accounts)
write_csv("assessments.csv", assessments)
write_csv("assessment_line_items.csv", line_items)
write_csv("payments.csv", payments)
write_csv("payment_allocations.csv", allocations)
write_csv("instruments.csv", instruments)
write_csv("requests_to_pay.csv", rtps)
write_csv("bank_statement_camt053.csv", bank_rows)
write_csv("switch_settlement_1link.csv", switch_rows)
write_csv("rail_settlement_raast.csv", rail_rows)
write_csv("scroll_fbr_20260730.csv", scroll_lines)
write_csv("bulk_payment_input.csv", bulk_input)

with open(os.path.join(OUT, "qr-payloads.json"), "w", encoding="utf-8") as f:
    json.dump(qr_samples, f, indent=2)

# ---- scroll sample (fixed-width, as a treasury would receive it) --------
fbr = next(a for a in AGENCIES if a[0] == "FBR")
scroll_total = sum(sl["amount_minor"] for sl in scroll_lines)
head_totals = {}
for sl in scroll_lines:
    head_totals[sl["revenue_head_code"]] = head_totals.get(sl["revenue_head_code"], 0) + sl["amount_minor"]
detail_block = ""
lines_out = []
lines_out.append(f"HDR|FBR|{fbr[1]}|NEXUSCOLLECT LIMITED|{RECON_DATE}|FBR-SCR-20260730-01|v1.0|"
                 f"{len(scroll_lines):06d}|{scroll_total/100:.2f}|"
                 f"{GENERATED_AT}")
for sl in scroll_lines:
    row = (f"DTL|{sl['line_no']:06d}|{sl['revenue_head_code']}|{sl['psid']}|"
           f"{sl['payer_name'][:40]:<40}|{sl['payer_id_masked']:<20}|{sl['tax_period']:<10}|"
           f"{sl['amount_minor']/100:>15.2f}|{sl['payment_reference']:<12}|{sl['receipt_no']:<24}|"
           f"{sl['channel']:<10}|{sl['rail']:<16}|{sl['value_date']}|"
           f"{sl['instrument_type']:<10}|{sl['collecting_branch']:<12}")
    lines_out.append(row)
    detail_block += row + "\n"
for hc in sorted(head_totals):
    lines_out.append(f"HTL|{hc}|{head_totals[hc]/100:.2f}")
lines_out.append(f"TRL|{len(scroll_lines):06d}|{scroll_total/100:.2f}|"
                 f"{hashlib.sha256(detail_block.encode()).hexdigest()}")
with open(os.path.join(OUT, "scroll-sample.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines_out) + "\n")

# ----------------------------------------------------------------------------
# EXPECTED RESULTS
# ----------------------------------------------------------------------------
applied = [al for al in allocations if al["status"] == "APPLIED"]
reversed_al = [al for al in allocations if al["status"] == "REVERSED"]
status_counts = {}
for a in assessments:
    status_counts[a["status"]] = status_counts.get(a["status"], 0) + 1
pay_status = {}
for p in payments:
    pay_status[p["status"]] = pay_status.get(p["status"], 0) + 1
chan_counts = {}
for p in payments:
    chan_counts[p["channel"]] = chan_counts.get(p["channel"], 0) + 1
rail_counts = {}
for p in payments:
    rail_counts[p["rail"]] = rail_counts.get(p["rail"], 0) + 1
head_alloc = {}
for al in applied:
    head_alloc[al["revenue_head_code"]] = head_alloc.get(al["revenue_head_code"], 0) + al["amount_minor"]
agency_alloc = {}
for al in applied:
    a = by_id[al["assessment_id"]]
    agency_alloc[a["agency_code"]] = agency_alloc.get(a["agency_code"], 0) + al["amount_minor"]

# Exact bank-vs-platform matches on the reconciliation date, computed rather than
# asserted: a bank row matches when its end_to_end_id ties to a platform payment of
# the SAME value date and the SAME amount. B02 has no row, the two B05 rows moved to
# 07-31, B03's row is 5,000 paisa short, and the two B01 rows have no e2e id at all.
_pay_by_e2e = {p["rail_e2e_id"]: p for p in payments if p["rail_e2e_id"]}
exact_matches = 0
for r in bank_rows:
    if r["value_date"] != RECON_DATE or not r["end_to_end_id"]:
        continue
    p = _pay_by_e2e.get(r["end_to_end_id"])
    if p and p["value_date"] == r["value_date"] and p["gross_amount_minor"] == r["amount_minor"]:
        exact_matches += 1
matched_expected = exact_matches
waterfalls_used = sorted({p["allocation_waterfall"] for p in product_by_code.values()})
rtp_states_used = sorted({r["status"] for r in rtps})

expected = {
  "generated_at": GENERATED_AT,
  "generator": "scripts/generate_demo_data.py (seed 20260730, deterministic)",
  "business_date_under_reconciliation": RECON_DATE,
  "entity_counts": {
    "agencies": len(AGENCIES), "revenue_heads": len(REVENUE_HEADS),
    "reference_schemes": len(REFERENCE_SCHEMES), "products": len(product_by_code),
    "payers": len(payers), "payer_accounts": len(payer_accounts),
    "assessments": len(assessments), "assessment_line_items": len(line_items),
    "payments": len(payments), "payment_allocations_total": len(allocations),
    "payment_allocations_applied": len(applied),
    "payment_allocations_reversed": len(reversed_al),
    "instruments": len(instruments), "requests_to_pay": len(rtps),
    "bank_statement_rows": len(bank_rows), "switch_settlement_rows": len(switch_rows),
    "rail_settlement_rows": len(rail_rows), "scroll_lines": len(scroll_lines),
    "qr_payloads": len(qr_samples),
  },
  "control_totals_minor": {
    "assessed_total": sum(a["assessed_amount_minor"] for a in assessments),
    "payable_total": sum(a["payable_amount_minor"] for a in assessments),
    "allocated_total": sum(a["allocated_amount_minor"] for a in assessments),
    "outstanding_balance_total": sum(a["balance_minor"] for a in assessments),
    "payments_gross_confirmed": sum(p["gross_amount_minor"] for p in payments
                                    if p["status"] == "CONFIRMED"),
    "payments_gross_all": sum(p["gross_amount_minor"] for p in payments),
    "allocations_applied_total": sum(al["amount_minor"] for al in applied),
    "allocations_reversed_total": sum(al["amount_minor"] for al in reversed_al),
    "unapplied_total": sum(p["unapplied_amount_minor"] for p in payments),
    "bank_statement_credit_total": sum(r["amount_minor"] for r in bank_rows),
    "switch_settlement_total": sum(r["transaction_amount_minor"] for r in switch_rows),
    "rail_settlement_txn_total": sum(r["amount_minor"] for r in rail_rows),
    "scroll_total": scroll_total,
  },
  "distributions": {
    "assessment_status": status_counts, "payment_status": pay_status,
    "payments_by_channel": chan_counts, "payments_by_rail": rail_counts,
    "allocation_waterfalls_used": waterfalls_used,
    "rtp_states_used": rtp_states_used,
    "instrument_status": {s: len([i for i in instruments if i["status"] == s])
                          for s in sorted({i["status"] for i in instruments})},
  },
  "head_wise_allocated_minor": dict(sorted(head_alloc.items())),
  "agency_wise_allocated_minor": dict(sorted(agency_alloc.items())),
  "planted_reconciliation_breaks": {
    "total_breaks": len(planted),
    "distinct_break_codes": sorted(set(b["break_code"] for b in planted)),
    "auto_resolvable_count": len([b for b in planted if b["auto_resolvable"]]),
    "manual_count": len([b for b in planted if not b["auto_resolvable"]]),
    "total_break_amount_minor": sum(b["amount_minor"] for b in planted),
    "breaks": planted,
  },
  "expected_recon_outcome_three_way_daily": {
    "note": "A correct engine reconciles the 2026-07-30 value-date population and reports "
            "exactly 11 breaks with the codes and amounts above. Nothing more, nothing less.",
    "platform_payments_on_date_all_statuses":
        len([p for p in payments if p["value_date"] == RECON_DATE]),
    "platform_payments_on_date_confirmed": len(on_date),
    "expected_exact_matches_bank_vs_platform": matched_expected,
    "expected_break_count": len(planted),
    "must_not_alarm_on": ["B05"],
    "must_auto_resolve": ["B04", "B05"],
    "must_escalate": ["B08", "B02", "B01(unresolvable)", "B06"],
  },
  "narrative_parsing_test_corpus": [
    {"narrative": f"PSID {qr_a['psid']} INCOME TAX", "expected": "AUTO_APPLY_EXACT"},
    {"narrative": f"TAX PYMT {'-'.join([qr_a['psid'][i:i+4] for i in range(0,16,4)])}-{qr_a['psid'][16]}",
     "expected": "AUTO_APPLY_AFTER_NORMALISATION"},
    {"narrative": f"{rf_reference(qr_a['psid'])} PSCA", "expected": "AUTO_APPLY_VIA_RF"},
    {"narrative": qr_a['psid'][:-1] + str((int(qr_a['psid'][-1]) + 1) % 10),
     "expected": "UNAPPLIED_CHECKSUM_FAILED"},
    {"narrative": f"TOKEN TAX {demo_vehicle.replace('-', ' ')}", "expected": "REVIEW_QUEUE_SCORE_45"},
    {"narrative": "TAX PAYMENT AHMED", "expected": "UNAPPLIED_BREAK_RAISED"},
    {"narrative": f"PAYMENT FOR {qr_a['psid']} AND {qr_b['psid']}",
     "expected": "REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS"},
  ],
  "demo_walkthrough_anchors": {
    "multi_payable_vehicle_lookup": {
      "note": "THE headline demo. POST /v1/resolve with this key must return the open "
              "payables only, each with its live amount including any early-payment "
              "discount, plus a resolution_token. The settled challan must come back "
              "as ALREADY_SETTLED with its receipt, not as NOT_FOUND.",
      "key_type": "VEHICLE_REG", "key_value": demo_vehicle,
      "expected_open_payables": len([a for a in assessments
                                     if demo_vehicle in a["metadata"]
                                     and a["status"] in ("ISSUED", "OVERDUE", "PARTIALLY_PAID")]),
      "open_payables": [
        {"psid": a["psid"], "product_code": a["product_code"], "status": a["status"],
         "payable_amount_minor": a["payable_amount_minor"],
         "discount_applied_minor": a["discount_applied_minor"],
         "description": a["description"]}
        for a in assessments if demo_vehicle in a["metadata"]
        and a["status"] in ("ISSUED", "OVERDUE", "PARTIALLY_PAID")],
      "already_settled_payables": [
        {"psid": a["psid"], "product_code": a["product_code"], "status": a["status"]}
        for a in assessments if demo_vehicle in a["metadata"]
        and a["status"] == "SETTLED"],
    },
    "qr_multi_payable_payment": {
      "note": "One QR scan clearing two challans on one vehicle, oldest first.",
      "key_type": "VEHICLE_REG", "key_value": demo_vehicle2,
      "psids": [a["psid"] for a in scenD_qr],
      "total_paid_minor": demo_total,
    },
    "returned_cheque_chain": {
      "instrument_id": i4["instrument_id"], "instrument_number": i4["instrument_number"],
      "amount_minor": ret_amount, "return_reason": "INSUFFICIENT_FUNDS",
      "assessments_unsettled": [a["assessment_id"] for a in ret_targets],
      "psids_unsettled": [a["psid"] for a in ret_targets],
      "dishonour_charge_psid": dishon["psid"],
      "reversed_allocation_count": len([al for al in allocations
                                        if al["payment_id"] == ret_pay["payment_id"]]),
    },
    "bulk_file": {
      "bulk_batch_id": "BULK-2026-07-29-0001", "challan_count": len(scenB),
      "single_credit_minor": bulk_total,
      "allocation_count": len([al for al in applied
                               if al["payment_id"] in
                               [p["payment_id"] for p in payments
                                if p["bulk_batch_id"] == "BULK-2026-07-29-0001"]]),
      "input_file": "bulk_payment_input.csv",
      "input_row_count": len(bulk_input),
      "input_declared_total_minor": bulk_declared_total,
      "expected_validation_outcome": "REJECTED",
      "expected_invalid_rows": [
        {"row_no": 13, "psid": already_settled_psid, "error_code": "ALREADY_SETTLED"}],
      "note": "13 rows: 12 valid plus one referencing an already-settled PSID. Under the "
              "default REJECT_ALL shortfall/validation policy the entire file is rejected "
              "and nothing is committed. Rows 1-12 are the batch that was subsequently "
              "corrected and funded by the single credit above.",
    },
    "multi_head_payment_example": None,
    "unapplied_receipts": [
      {"payment_reference": unapp1["payment_reference"], "amount_minor": unapp1["gross_amount_minor"],
       "narrative": unapp1["remittance_raw"], "resolvable": True},
      {"payment_reference": unapp2["payment_reference"], "amount_minor": unapp2["gross_amount_minor"],
       "narrative": unapp2["remittance_raw"], "resolvable": False, "age_days": 14},
    ],
  },
}
# find a genuine multi-head payment for the walkthrough
for p in payments:
    als = [al for al in applied if al["payment_id"] == p["payment_id"]]
    heads = set(al["revenue_head_code"] for al in als)
    if len(heads) >= 3:
        expected["demo_walkthrough_anchors"]["multi_head_payment_example"] = {
            "payment_reference": p["payment_reference"], "gross_amount_minor": p["gross_amount_minor"],
            "channel": p["channel"], "rail": p["rail"],
            "allocations": [{"revenue_head_code": al["revenue_head_code"],
                             "amount_minor": al["amount_minor"]} for al in als],
        }
        break

with open(os.path.join(OUT, "expected-results.json"), "w", encoding="utf-8") as f:
    json.dump(expected, f, indent=2)

# ----------------------------------------------------------------------------
# VERIFY
# ----------------------------------------------------------------------------
def verify():
    errs = []
    # 1. checksums
    for a in assessments:
        sc = product_by_code[a["product_code"]]["reference_scheme_code"]
        if scheme_by_code[sc][4] == "DAMM" and not damm_valid(a["psid"]):
            errs.append(f"Damm invalid: {a['psid']}")
    # 2. line items sum to assessed
    for a in assessments:
        s = sum(l["amount_minor"] for l in lines_by_assessment[a["assessment_id"]])
        if s != a["assessed_amount_minor"]:
            errs.append(f"{a['assessment_id']} line sum {s} != assessed {a['assessed_amount_minor']}")
    # 3. per-payment allocation integrity
    for p in payments:
        if p["status"] != "CONFIRMED":
            continue
        prod_fee = 0
        als = sum(al["amount_minor"] for al in allocations
                  if al["payment_id"] == p["payment_id"] and al["status"] == "APPLIED")
        if als + p["unapplied_amount_minor"] + prod_fee != p["gross_amount_minor"]:
            errs.append(f"{p['payment_reference']}: applied {als} + unapplied "
                        f"{p['unapplied_amount_minor']} != gross {p['gross_amount_minor']}")
    # 4. assessment allocated == sum of applied allocations
    for a in assessments:
        s = sum(al["amount_minor"] for al in allocations
                if al["assessment_id"] == a["assessment_id"] and al["status"] == "APPLIED")
        if s != a["allocated_amount_minor"]:
            errs.append(f"{a['assessment_id']} allocated cache {a['allocated_amount_minor']} != {s}")
    # 5. balance identity
    for a in assessments:
        if a["balance_minor"] != a["payable_amount_minor"] - a["allocated_amount_minor"]:
            errs.append(f"{a['assessment_id']} balance identity broken")
    # 6. QR CRCs
    for q in qr_samples:
        body, crc = q["payload"][:-4], q["payload"][-4:]
        ok = f"{crc16_ccitt_false(body.encode()):04X}" == crc
        if ok != q["valid"]:
            errs.append(f"QR {q['name']}: CRC valid={ok}, expected {q['valid']}")
    # 7. bank statement ties to platform less planted deltas
    plat_in_bank = sum(p["gross_amount_minor"] for p in bank_candidates if p is not b02_victim)
    expect_bank = (plat_in_bank - B03_DELTA + b01_a["amount"] + b01_b["amount"])
    actual_bank = sum(r["amount_minor"] for r in bank_rows)
    if expect_bank != actual_bank:
        errs.append(f"bank total {actual_bank} != expected {expect_bank}")
    # 8. exactly 11 planted breaks, 9 distinct codes
    if len(planted) != 11:
        errs.append(f"planted break count {len(planted)} != 11")
    if len(set(b['break_code'] for b in planted)) != 9:
        errs.append(f"distinct break codes {len(set(b['break_code'] for b in planted))} != 9")
    # 9. EVERY planted break must actually be present in the source files.
    #    (A previous version silently lost B07 to a victim collision.)
    fee_variance_rows = [r for r in switch_rows if r["switch_fee_minor"] != 1_000]
    if len(fee_variance_rows) != 1:
        errs.append(f"B07 not materialised: {len(fee_variance_rows)} fee-variance rows in switch file")
    dup_keys = [(r["acquirer_id"], r["stan"], r["rrn"]) for r in switch_rows]
    if len(dup_keys) - len(set(dup_keys)) != 1:
        errs.append(f"B04 not materialised: {len(dup_keys)-len(set(dup_keys))} duplicate switch rows")
    if any(r["end_to_end_id"] == b02_victim["rail_e2e_id"] for r in bank_rows):
        errs.append("B02 not materialised: victim present in bank statement")
    if b02_victim["in_bank_statement"] != "N":
        errs.append("B02 victim still flagged in_bank_statement=Y")
    late = [r for r in bank_rows if r["value_date"] != RECON_DATE
            and r["end_to_end_id"] in {v["rail_e2e_id"] for v in b05_victims}]
    if len(late) != 2:
        errs.append(f"B05 not materialised: {len(late)} late-booked rows, expected 2")
    short = [r for r in bank_rows if r["end_to_end_id"] == b03_victim["rail_e2e_id"]
             and r["amount_minor"] != b03_victim["gross_amount_minor"]]
    if len(short) != 1:
        errs.append("B03 not materialised in bank statement")
    if len([r for r in scroll_lines if r["ack_status"] == "REJECTED"]) != 1:
        errs.append("B09 not materialised: scroll rejection count != 1")
    cyc = {r["cycle_id"]: r for r in rail_rows}
    if b08_cycle:
        constituents = sum(r["amount_minor"] for r in rail_rows if r["cycle_id"] == b08_cycle)
        declared = cyc[b08_cycle]["cycle_declared_net_minor"]
        if constituents - declared != B08_DELTA:
            errs.append(f"B08 not materialised: variance {constituents-declared} != {B08_DELTA}")
    # 10. every break's stated source_ref must be resolvable in the data
    for b in planted:
        if not b["source_ref"]:
            errs.append(f"{b['break_code']} has an empty source_ref")
    # 11. coverage claims made in the design doc must hold
    if set(waterfalls_used) != {"OLDEST_FIRST", "PENALTY_FIRST", "PRINCIPAL_FIRST",
                                "PRO_RATA", "EXPLICIT_ONLY"}:
        errs.append(f"not all 5 waterfalls in use: {waterfalls_used}")
    if len(rtp_states_used) < 8:
        errs.append(f"only {len(rtp_states_used)} distinct RtP states: {rtp_states_used}")
    if len({i["status"] for i in instruments}) != 4:
        errs.append(f"instrument statuses: {sorted({i['status'] for i in instruments})}")
    if len({p["channel"] for p in payments}) != 12:
        errs.append(f"channels covered: {len({p['channel'] for p in payments})} != 12")
    if len({p["rail"] for p in payments}) != 7:
        errs.append(f"rails covered: {len({p['rail'] for p in payments})} != 7")
    # 12. PRO_RATA must not lose or invent paisa
    for a in assessments:
        if a["waterfall"] != "PRO_RATA":
            continue
        s = sum(al["amount_minor"] for al in allocations
                if al["assessment_id"] == a["assessment_id"] and al["status"] == "APPLIED")
        if s != a["allocated_amount_minor"]:
            errs.append(f"PRO_RATA rounding drift on {a['assessment_id']}")
    # 13. PSIDs must carry the declared product code in digits 3..6
    for a in assessments:
        p = product_by_code[a["product_code"]]
        sch = scheme_by_code[p["reference_scheme_code"]]
        if not sch[7]:                      # legacy scheme: no platform product code
            continue
        pref = sch[3]
        got = a["psid"][len(pref):len(pref) + 4]
        if got != p["psid_product_code"]:
            errs.append(f"{a['psid']} product code {got} != {p['psid_product_code']}")
    # 14. provenance flags must agree with the three recon source files
    bank_e2e = {r["end_to_end_id"] for r in bank_rows if r["end_to_end_id"]}
    sw_e2e   = {r["end_to_end_id"] for r in switch_rows}
    rail_e2e = {r["end_to_end_id"] for r in rail_rows}
    for p in payments:
        e = p["rail_e2e_id"]
        for flag, present in (("in_bank_statement", e in bank_e2e),
                              ("in_switch_file",   e in sw_e2e),
                              ("in_rail_file",     e in rail_e2e)):
            if (p[flag] == "Y") != present:
                errs.append(f"{p['payment_reference']} {flag}={p[flag]} but present={present}")
    # 15. RtP fulfilment must be linked in both directions
    for r in rtps:
        if r["status"].startswith("FULFILLED"):
            if not r["fulfilling_payment_reference"]:
                errs.append(f"{r['rtp_reference']} FULFILLED with no fulfilling payment")
            fp = next((p for p in payments
                       if p["payment_reference"] == r["fulfilling_payment_reference"]), None)
            if not fp or fp["rtp_reference"] != r["rtp_reference"]:
                errs.append(f"{r['rtp_reference']} back-link missing on the payment")
            if fp and fp["rail_e2e_id"] != r["rtp_reference"]:
                errs.append(f"{r['rtp_reference']} EndToEndId != rtp_reference")
    # 16. scroll lines must carry a receipt number
    if any(not sl["receipt_no"] for sl in scroll_lines):
        errs.append("scroll line without a receipt_no")
    # 17. every instrument type must be permitted by its product
    for i in instruments:
        first = i["linked_assessment_ids"].split("|")[0]
        prod = product_by_code[by_id[first]["product_code"]]
        if i["instrument_type"] not in prod["allowed_instruments"].split("|"):
            errs.append(f"{i['instrument_id']} type {i['instrument_type']} not allowed "
                        f"for {prod['product_code']}")
    return errs

problems = verify()
print("=" * 74)
print("NexusCollect demo data generated ->", os.path.abspath(OUT))
print("=" * 74)
for k, v in expected["entity_counts"].items():
    print(f"  {k:38s} {v:>10,}")
print("-" * 74)
for k, v in expected["control_totals_minor"].items():
    print(f"  {k:38s} PKR {v/100:>16,.2f}")
print("-" * 74)
print(f"  planted breaks: {len(planted)} across "
      f"{len(set(b['break_code'] for b in planted))} distinct codes")
print("=" * 74)
if problems:
    print("VERIFICATION FAILED:")
    for e in problems[:40]:
        print("  !", e)
    raise SystemExit(1)
print("VERIFICATION PASSED: all 17 consistency and break-materialisation checks hold.")
