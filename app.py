from __future__ import annotations
import os
import re
import requests
from flask import Flask, request, abort
from twilio.rest import Client
from twilio.twiml.messaging_response import MessagingResponse
from twilio.request_validator import RequestValidator
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# ── Config (set these as environment variables) ──────────────────────────────
FINDAMINYAN_EMAIL    = os.environ['FINDAMINYAN_EMAIL']
FINDAMINYAN_PASSWORD = os.environ['FINDAMINYAN_PASSWORD']
TWILIO_ACCOUNT_SID   = os.environ['TWILIO_ACCOUNT_SID']
TWILIO_AUTH_TOKEN    = os.environ['TWILIO_AUTH_TOKEN']
TWILIO_FROM_NUMBER   = os.environ['TWILIO_FROM_NUMBER']   # Twilio UK number e.g. +441234567890
ADMIN_PHONE          = os.environ['ADMIN_PHONE']           # Your mobile e.g. +447700900123

BASE_URL = 'https://findaminyan.co.uk'

# Location types used by the site
LOC_INDIVIDUAL = 1
LOC_SHUL       = 2
LOC_CAMP       = 3


# ── Date helpers ─────────────────────────────────────────────────────────────

def format_date_for_api(d: datetime) -> str:
    """Format as '1 Aug 26'  (site expects D MMM YY)"""
    return f"{d.day} {d.strftime('%b')} {d.strftime('%y')}"


# ── SMS parser ───────────────────────────────────────────────────────────────

def parse_sms(text: str) -> dict | None:
    """
    Parse messages like:
      '2 men, 01/08/26-11/08/26, M7 1HW'
      '3 people, 1/8/2026 to 11/8/2026, SW1A 1AA'

    Returns dict with num_people, start, end, postcode — or None if unparseable.
    """
    text = text.strip()

    # Number of people
    m = re.search(r'(\d+)\s*(?:men|man|people|person|males?)?', text, re.IGNORECASE)
    num_people = int(m.group(1)) if m else 1
    num_people = min(num_people, 9)   # site max for individuals is 9

    # Date range  DD/MM/YY–DD/MM/YY  or  DD/MM/YYYY to DD/MM/YYYY
    date_re = r'(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4})\s*(?:[-–—]|to)\s*(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4})'
    dm = re.search(date_re, text, re.IGNORECASE)
    if not dm:
        return None

    def parse_date(s: str) -> datetime | None:
        s = re.sub(r'[.\-]', '/', s)
        for fmt in ('%d/%m/%y', '%d/%m/%Y', '%m/%d/%y', '%m/%d/%Y'):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                pass
        return None

    start = parse_date(dm.group(1))
    end   = parse_date(dm.group(2))
    if not start or not end:
        return None

    # UK postcode
    pm = re.search(r'\b([A-Z]{1,2}\d[0-9A-Z]?\s*\d[A-Z]{2})\b', text, re.IGNORECASE)
    if not pm:
        return None
    postcode = pm.group(1).upper().strip()

    return {
        'num_people': num_people,
        'start': start,
        'end': end,
        'postcode': postcode,
    }


# ── Geocoding ─────────────────────────────────────────────────────────────────

def geocode_postcode(postcode: str) -> tuple[float | None, float | None, str]:
    """Return (lat, lng, human_address) via postcodes.io (free, no API key)."""
    clean = postcode.replace(' ', '').upper()
    try:
        r = requests.get(f'https://api.postcodes.io/postcodes/{clean}', timeout=5)
        d = r.json()
        if d.get('status') == 200:
            res  = d['result']
            lat  = res['latitude']
            lng  = res['longitude']
            parts = [p for p in [
                res.get('admin_ward'),
                res.get('admin_district'),
                res.get('admin_county'),
                res.get('country'),
            ] if p]
            addr = (', '.join(parts) + f', {postcode.upper()}, UK') if parts else f'{postcode.upper()}, UK'
            return lat, lng, addr
    except Exception:
        pass
    return None, None, f'{postcode.upper()}, UK'


# ── Site API helpers ──────────────────────────────────────────────────────────

def login_to_site() -> requests.Session | None:
    """Log in and return an authenticated session (cookie-based)."""
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (compatible; FindAMinyanBot/1.0)',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': BASE_URL,
    })
    session.get(BASE_URL, timeout=10)       # pick up initial cookies

    resp = session.post(
        f'{BASE_URL}/LogIn',
        data={'email': FINDAMINYAN_EMAIL, 'password': FINDAMINYAN_PASSWORD},
        timeout=10,
    )
    # Site returns '1' (not found), '2' (not active) on failure; empty/redirect on success
    if resp.text.strip() in ('1', '2', '3'):
        return None
    return session


def add_location(
    session: requests.Session,
    postcode: str,
    num_people: int,
    start: datetime,
    end: datetime,
    lat: float,
    lng: float,
    address: str,
    mobile: str = '',
) -> bool:
    """POST an individual location to /Member/UpdateLocation."""
    resp = session.post(
        f'{BASE_URL}/Member/UpdateLocation',
        data={
            'LocationType':  'ind',
            'Postcode':      postcode.upper(),
            'NumberOfPeople': num_people,
            'Mobile':        mobile,
            'Email':         FINDAMINYAN_EMAIL,
            'StartDate':     format_date_for_api(start),
            'EndDate':       format_date_for_api(end),
            'Name':          '',
            'Address':       address,
            'Contact':       '',
            'Latitude':      lat,
            'Longitude':     lng,
        },
        headers={'Referer': f'{BASE_URL}/AddNew'},
        timeout=15,
    )
    return resp.text.strip() == 'OK'


def search_nearby(
    session: requests.Session,
    lat: float,
    lng: float,
    start: datetime,
    end: datetime,
    distance: int = 15,
) -> dict:
    """GET /Home/GetTimeLineData — returns JSON with all nearby locations."""
    resp = session.get(
        f'{BASE_URL}/Home/GetTimeLineData',
        params={
            'from':     format_date_for_api(start),
            'to':       format_date_for_api(end),
            'lat':      lat,
            'lng':      lng,
            'address':  f'{lat},{lng}',
            'distance': distance,
        },
        headers={'Referer': f'{BASE_URL}/Member'},
        timeout=15,
    )
    return resp.json()


def count_people_nearby(data: dict) -> tuple[int, list[dict]]:
    """
    Count total people (individuals + camp attendees) from GetTimeLineData response.
    Returns (total_count, list_of_entry_dicts).
    """
    total   = 0
    entries = []
    for loc in data.get('timeLineData', []):
        if loc.get('LocationType') in (LOC_INDIVIDUAL, LOC_CAMP):
            n = int(loc.get('NumberOfPeople') or 0)
            if n > 0:
                total += n
                entries.append({
                    'postcode': loc.get('Postcode', ''),
                    'people':   n,
                    'phone':    loc.get('Mobile') or loc.get('Telephone') or '',
                    'email':    loc.get('Email', ''),
                })
    return total, entries


# ── Admin notification ────────────────────────────────────────────────────────

def notify_admin(
    total: int,
    postcode: str,
    start: datetime,
    end: datetime,
    entries: list[dict],
    requester_number: str,
) -> None:
    """Send admin an SMS summary when a minyan looks possible."""
    client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    lines = [
        f"MINYAN ALERT — {total} people near {postcode}",
        f"Dates: {start.strftime('%d/%m/%y')}–{end.strftime('%d/%m/%y')}",
        f"Requester: {requester_number}",
        '',
    ]
    for e in entries[:8]:
        contact = e['phone'] or e['email'] or 'no contact'
        lines.append(f"• {e['people']} @ {e['postcode']} | {contact}")

    lines.append(f"\nView: {BASE_URL}/Member")
    client.messages.create(to=ADMIN_PHONE, from_=TWILIO_FROM_NUMBER, body='\n'.join(lines))


# ── Webhook ───────────────────────────────────────────────────────────────────

@app.route('/sms', methods=['POST'])
def handle_sms():
    # Verify the request genuinely came from Twilio
    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    if not validator.validate(
        request.url,
        request.form.to_dict(),
        request.headers.get('X-Twilio-Signature', ''),
    ):
        abort(403)

    from_number = request.form.get('From', '')
    body        = request.form.get('Body', '').strip()

    twiml = MessagingResponse()

    # ── 1. Parse SMS ──────────────────────────────────────────────────────────
    parsed = parse_sms(body)
    if not parsed:
        twiml.message(
            "Hi! I couldn't read your message.\n"
            "Please send it like this:\n"
            "  2 men, 01/08/26-11/08/26, M7 1HW\n"
            "(people · dates · postcode)"
        )
        return str(twiml)

    postcode    = parsed['postcode']
    num_people  = parsed['num_people']
    start       = parsed['start']
    end         = parsed['end']
    date_range  = f"{start.strftime('%d/%m/%y')}–{end.strftime('%d/%m/%y')}"

    # ── 2. Geocode ────────────────────────────────────────────────────────────
    lat, lng, address = geocode_postcode(postcode)
    if lat is None:
        twiml.message(
            f"Sorry, I couldn't find postcode {postcode}. "
            "Please double-check it and try again."
        )
        return str(twiml)

    # ── 3. Login ──────────────────────────────────────────────────────────────
    session = login_to_site()
    if not session:
        twiml.message(
            "Sorry, there was a system error. "
            "Please try again in a few minutes."
        )
        return str(twiml)

    # ── 4. Add location to site ───────────────────────────────────────────────
    # Convert +44 → 07... format
    sender_mobile = from_number
    if sender_mobile.startswith('+44'):
        sender_mobile = '0' + sender_mobile[3:]

    add_location(session, postcode, num_people, start, end, lat, lng, address, mobile=sender_mobile)

    # ── 5. Search for nearby people ───────────────────────────────────────────
    nearby_data          = search_nearby(session, lat, lng, start, end, distance=15)
    total_nearby, entries = count_people_nearby(nearby_data)

    # ── 6. Build reply ────────────────────────────────────────────────────────
    if total_nearby >= 8:
        reply = (
            f"Great news! We have {total_nearby} people within 15 miles of "
            f"{postcode} for {date_range} — enough for a minyan! "
            f"The admin will be in touch shortly with contact details."
        )
        notify_admin(total_nearby, postcode, start, end, entries, sender_mobile)
    else:
        needed = max(0, 10 - total_nearby)
        reply = (
            f"We currently have {total_nearby} people near {postcode} for "
            f"{date_range}. Still need {needed} more for a minyan. "
            f"Your details have been added to the site — "
            f"please check back in 1–2 weeks!"
        )

    twiml.message(reply)
    return str(twiml)


# ── Health check (for Render/Railway uptime pings) ────────────────────────────
@app.route('/health')
def health():
    return 'OK', 200


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
