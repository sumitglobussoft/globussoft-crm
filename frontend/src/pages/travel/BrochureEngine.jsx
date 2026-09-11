// Travel CRM — TMC School Brochure Engine page (simplified wizard).
//
// Flow: Import from itinerary (optional) → 5 clear steps → Generate.
// Backend contract is unchanged from the previous form-based page.

import { useState, useEffect, useCallback, useRef, useMemo, useContext, createContext } from 'react';
import {
  Sparkles,
  Loader,
  History as HistoryIcon,
  Wand2,
  Trash2,
  Download,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  X,
  Cpu,
  Users,
  ChevronDown,
  ChevronUp,
  MapPin,
  Calendar,
  CreditCard,
  Briefcase,
  MessageSquare,
  Upload,
  ArrowRight,
  ArrowLeft,
  Info,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { summarizeImportedHotels, summarizeImportedTransfers } from '../../utils/brochureEditorial';
import { geocodeSuggest } from '../../lib/geocoder';

const DEFAULT_SECTOR = 'travel';
const DEFAULT_STYLE = 'tmc-school';

// A form this long (5 steps, dozens of fields) is real work to fill in —
// losing it to an accidental refresh/tab-close is exactly the kind of thing
// that makes people distrust a tool. Auto-saved locally, restored on load,
// cleared explicitly (never silently, since a stale draft from a different
// trip would be worse than no draft).
const DRAFT_STORAGE_KEY = 'tmc-brochure-engine-draft-v1';

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveDraft(tripInput, brand) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ tripInput, brand, savedAt: Date.now() }));
  } catch {
    /* storage full/unavailable — draft just won't persist this time */
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch { /* ignore */ }
}

// ─── Smart combo-dropdown persistence ───────────────────────────────────────
// Fields like "Occupancy basis" repeat the same handful of answers across
// almost every trip — a plain text box means re-typing the exact same phrase
// every single time. These fields keep a per-field list of values the user
// has typed before, saved locally, offered back as quick picks next time —
// alongside a curated starter list so it's useful from the very first use.
const COMBO_CUSTOM_PREFIX = 'tmc-combo-custom:';

function loadComboCustomOptions(fieldKey) {
  try {
    const raw = localStorage.getItem(COMBO_CUSTOM_PREFIX + fieldKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

function saveComboCustomOptions(fieldKey, list) {
  try {
    localStorage.setItem(COMBO_CUSTOM_PREFIX + fieldKey, JSON.stringify(list));
  } catch { /* storage full/unavailable — the value itself still saved via onChange */ }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function todayInputDate() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

function addDaysInputDate(dateStr, days) {
  const d = new Date(dateStr || todayInputDate());
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDateLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Itinerary-import helpers ───────────────────────────────────────────────
// The Itinerary model's inclusionsJson/exclusionsJson/detailsJson columns are
// free-form JSON text (see backend/prisma/schema.prisma Itinerary + ItineraryItem)
// — never trust their shape, always parse defensively.
function safeJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Hotel "board" (meal plan) codes → which meals are included, so the itinerary
// import can prefill Breakfasts/Lunches/Dinners counts instead of leaving them
// for the user to re-type from the same hotel bookings.
const BOARD_MEALS = {
  RO: [], EP: [],
  BB: ['breakfast'],
  HB: ['breakfast', 'dinner'],
  FB: ['breakfast', 'lunch', 'dinner'],
  AI: ['breakfast', 'lunch', 'dinner'],
  'ALL-INCLUSIVE': ['breakfast', 'lunch', 'dinner'],
};

// Shared with the `primaryDestinationCity` memo inside the component — this
// standalone version is for use inside setState updaters (addDay,
// syncDaysToDuration) where only the raw `prev` trip object is available.
function primaryCityOf(trip) {
  const cities = (trip.overnightCities || []).map((o) => o.city).filter(Boolean);
  const unique = [...new Set(cities)];
  if (unique.length === 1) return unique[0];
  return trip.destinationCountry || '';
}

// School identity (name/logo/approval/brand-kit) lives on the separate
// `brand` state (Step 1 writes to it directly), but validation and the
// actual submit payload need it merged onto tripInput. This is the ONE place
// that merge happens — both the live validation banner and the real submit
// gate call this, so they can never disagree about what's actually missing
// (they used to: the banner checked tripInput.schoolName directly, which
// Step 1 never writes to, so it permanently showed "School name is
// required" etc. even when correctly filled in).
function mergeBrandIntoTripInput(tripInput, brand) {
  return {
    ...tripInput,
    schoolName: tripInput.schoolName || brand.schoolName,
    schoolLogoUrl: tripInput.schoolLogoUrl || brand.schoolLogoUrl,
    schoolLogoFileName: tripInput.schoolLogoFileName || brand.schoolLogoFileName,
    schoolLogoApproved: tripInput.schoolLogoApproved || brand.schoolLogoApproved,
    tmcBrandKitId: tripInput.tmcBrandKitId || brand.tmcBrandKitId,
  };
}

// Catches the "wrote a new trip's dates/itinerary but the Trip
// summary/Primary objective still talk about a totally different place"
// mistake — very easy to hit once a draft persists across sessions (a field
// nobody thought to re-check after switching trips). Only flags an
// UNAMBIGUOUS mismatch (a different known destination name present, the real
// one absent) — never blocks, just asks for a confirm before generating a
// brochure with a leftover, wrong destination baked into its prose.
function detectDestinationMismatch(t) {
  const dest = String(t.destinationCountry || '').trim().toLowerCase();
  if (!dest) return null;
  const prose = [t.tripSummary, t.primaryObjective].filter(Boolean).join(' ').toLowerCase();
  if (!prose || prose.includes(dest)) return null;
  return POPULAR_DESTINATIONS.find((d) => {
    const lower = d.toLowerCase();
    return lower !== dest && !dest.includes(lower) && !lower.includes(dest) && prose.includes(lower);
  }) || null;
}

function emptyTripInput() {
  const from = todayInputDate();
  const to = addDaysInputDate(from, 6);
  return {
    schoolName: '',
    schoolLogoUrl: '',
    schoolLogoFileName: '',
    schoolLogoFormat: 'png',
    schoolLogoApproved: false,
    tmcBrandKitId: '',
    schoolLogoVersion: 'full-colour',
    partnerLogos: [],
    coBrandingWording: '',
    specialLogoInstructions: '',
    tripTitle: '',
    educationalSubtitle: '',
    destinationCountry: '',
    travelDates: { from, to },
    durationDays: 7,
    durationNights: 6,
    targetGrades: '',
    tripSummary: '',
    expectedStudents: '',
    minGroupSize: '',
    maxGroupSize: '',
    teachers: '',
    tourManagers: '',
    studentAdultRatio: '',
    departureBatches: '',
    primaryObjective: '',
    learningOutcomes: ['', '', ''],
    curriculumConnection: '',
    skillsDeveloped: '',
    specialSchoolRequirements: '',
    routeCities: '',
    arrivalAirport: '',
    departureAirport: '',
    dayVisitLocations: [],
    overnightCities: [{ city: '', nights: 1 }],
    days: [
      { dayNumber: 1, date: from, route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 2, date: addDaysInputDate(from, 1), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 3, date: addDaysInputDate(from, 2), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 4, date: addDaysInputDate(from, 3), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 5, date: addDaysInputDate(from, 4), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 6, date: addDaysInputDate(from, 5), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
      { dayNumber: 7, date: addDaysInputDate(from, 6), route: '', departureTime: '', arrivalTime: '', activities: '', meals: [], overnightCity: '', learningTakeaway: '', travelDuration: '', physicalDemands: '', optionalActivities: '', separatePaymentItems: '' },
    ],
    flights: { status: 'included', airline: '', flightNumbers: '', departure: '', arrival: '', baggage: '' },
    airportTransfers: '',
    intercityTransport: '',
    localTransport: '',
    railJourneys: '',
    longTravelSectors: '',
    hotels: [{ name: '', city: '', category: '', nights: '' }],
    roomSharingBasis: '',
    teacherRoomArrangement: '',
    breakfasts: '',
    lunches: '',
    dinners: '',
    specialMeals: '',
    dietarySupport: '',
    mealsExcluded: '',
    inclusions: [''],
    exclusions: [''],
    costStatus: {
      airfare: 'included',
      gst: 'included',
      tcs: 'included',
      travelInsurance: 'included',
      visaPermit: 'na',
      destinationEntryFee: 'na',
      entranceFees: 'included',
      tips: 'included',
      personalExpenses: 'excluded',
      otherCompulsoryCharge: '',
    },
    passportVisa: '',
    consentForms: '',
    insuranceDetails: '',
    supervisionEmergency: '',
    accessibilityNeeds: '',
    curfewRules: '',
    passportCustody: '',
    currency: 'INR',
    pricePerPerson: '',
    occupancyBasis: '',
    singleSupplement: '',
    studentPrice: '',
    teacherPrice: '',
    taxesIncluded: '',
    taxesExcluded: '',
    priceValidity: '',
    minPayingGroup: '',
    deposit: { amount: '', dueDate: '' },
    instalments: [],
    finalPaymentDate: '',
    bookingDeadline: '',
    cancellationTerms: '',
    paymentLink: '',
    paymentButtonLabel: 'Make payment',
    paymentQr: false,
    paymentLinkApproved: false,
    paymentLinkExpiry: '',
    paymentInstructions: '',
    themeMode: 'auto',
    travelSeason: '',
    preferredMood: '',
    preferredColours: '',
    coloursToAvoid: '',
    visualInspiration: '',
    manualHexPalette: { primary: '', secondary: '', accent: '', background: '', text: '' },
    themeApproval: 'generate',
    destinationImagesUploaded: false,
    studentImagesUploaded: false,
    imageConsentConfirmed: false,
    imagesToAvoid: '',
    primaryPhone: '',
    email: '',
    website: '',
    whatsapp: '',
    youtube: '',
    facebook: '',
    instagram: '',
    generalQrUrl: '',
    callToAction: '',
    mapStyle: 'default-2d',
    requiredMarkers: [],
    locationsToExclude: [],
    uploadedFiles: [],
    factsAwaitingConfirmation: '',
    knownContradictions: '',
    doNotPrint: '',
    previousTripReferences: '',
    finalApprovalContact: '',
  };
}

function validateTripInput(trip) {
  const errors = [];
  const r = (path, msg) => errors.push({ path, msg });
  const t = trip || {};

  if (!String(t.schoolName || '').trim()) r('schoolName', 'School name is required.');
  if (!String(t.schoolLogoUrl || '').trim()) r('schoolLogoUrl', 'School logo is required.');
  if (!String(t.schoolLogoFileName || '').trim()) r('schoolLogoFileName', 'School logo file name is required.');
  if (!t.schoolLogoApproved) r('schoolLogoApproved', 'Please confirm the school logo is approved.');
  if (!String(t.tmcBrandKitId || '').trim()) r('tmcBrandKitId', 'TMC brand kit ID is required.');
  if (!String(t.tripTitle || '').trim()) r('tripTitle', 'Trip title is required.');
  if (!String(t.destinationCountry || '').trim()) r('destinationCountry', 'Destination country is required.');
  if (!String(t.travelDates?.from || '').trim()) r('travelDates.from', 'Start date is required.');
  if (!String(t.travelDates?.to || '').trim()) r('travelDates.to', 'End date is required.');
  if (!t.durationDays) r('durationDays', 'Duration (days) is required.');
  if (t.durationDays && (t.days || []).length !== Number(t.durationDays)) {
    r('days', `Duration is set to ${t.durationDays} day(s) but the itinerary has ${(t.days || []).length} day card(s) — use "Match days to duration" in step 3.`);
  }
  if (!t.durationNights && t.durationNights !== 0) r('durationNights', 'Duration (nights) is required.');
  if (!String(t.targetGrades || '').trim()) r('targetGrades', 'Target grades are required.');
  if (!String(t.tripSummary || '').trim()) r('tripSummary', 'Trip summary is required.');
  if (!String(t.primaryObjective || '').trim()) r('primaryObjective', 'Primary objective is required.');
  const outcomes = (t.learningOutcomes || []).filter((x) => String(x || '').trim());
  if (outcomes.length < 3) r('learningOutcomes', 'At least 3 learning outcomes are required.');
  if (!String(t.routeCities || '').trim()) r('routeCities', 'Route cities are required.');
  const overnights = (t.overnightCities || []).filter((x) => String(x.city || '').trim());
  if (overnights.length === 0) r('overnightCities', 'At least one overnight city is required.');

  (t.days || []).forEach((day, i) => {
    if (!day.dayNumber) r(`days[${i}].dayNumber`, `Day ${i + 1}: number is required.`);
    if (!String(day.date || '').trim()) r(`days[${i}].date`, `Day ${i + 1}: date is required.`);
    if (!String(day.route || '').trim()) r(`days[${i}].route`, `Day ${i + 1}: route is required.`);
    if (!String(day.activities || '').trim()) r(`days[${i}].activities`, `Day ${i + 1}: activities are required.`);
    if (!String(day.overnightCity || '').trim()) r(`days[${i}].overnightCity`, `Day ${i + 1}: overnight city is required.`);
  });

  const inclusions = (t.inclusions || []).filter((x) => String(x || '').trim());
  if (inclusions.length === 0) r('inclusions', 'At least one inclusion is required.');
  const exclusions = (t.exclusions || []).filter((x) => String(x || '').trim());
  if (exclusions.length === 0) r('exclusions', 'At least one exclusion is required.');

  if (!String(t.currency || '').trim()) r('currency', 'Currency is required.');
  if (!t.pricePerPerson && t.pricePerPerson !== 0) r('pricePerPerson', 'Price per person is required.');
  if (!String(t.occupancyBasis || '').trim()) r('occupancyBasis', 'Occupancy basis is required.');
  if (!t.deposit?.amount && t.deposit?.amount !== 0) r('deposit.amount', 'Deposit amount is required.');
  if (!String(t.deposit?.dueDate || '').trim()) r('deposit.dueDate', 'Deposit due date is required.');

  if (!String(t.themeMode || '').trim()) r('themeMode', 'Theme mode is required.');
  if (!String(t.travelSeason || '').trim()) r('travelSeason', 'Travel season is required.');

  if (!String(t.primaryPhone || '').trim()) r('primaryPhone', 'Primary phone is required.');
  const emailVal = String(t.email || '').trim();
  if (!emailVal) r('email', 'Email is required.');
  // Format-checked here (not left to the browser's native type="email" popup,
  // which is disabled via `noValidate` so it can't fight this validation UX)
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) r('email', 'Enter a valid email address.');
  const websiteVal = String(t.website || '').trim();
  if (!websiteVal) r('website', 'Website is required.');
  else if (!/^https?:\/\/.+\..+/i.test(websiteVal)) r('website', 'Enter a valid website URL (starting with http:// or https://).');
  if (!String(t.callToAction || '').trim()) r('callToAction', 'Call to action is required.');

  return errors;
}

// ─── Small UI primitives ───────────────────────────────────────────────────

function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', marginLeft: 6, verticalAlign: 'middle' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      tabIndex={0}
    >
      <Info size={14} style={{ color: 'var(--text-secondary)', cursor: 'help' }} aria-hidden="true" />
      {show && (
        <span
          style={{
            position: 'absolute',
            bottom: '120%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 260,
            padding: 8,
            borderRadius: 6,
            background: 'var(--text-primary)',
            color: 'var(--bg-color)',
            fontSize: 12,
            zIndex: 100,
            boxShadow: '0 4px 12px rgba(0,0,0,.25)',
            lineHeight: 1.4,
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function LabelWithInfo({ label, tip, required, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {label}
      {required && <span style={{ color: '#e06a5a' }}>*</span>}
      {tip && <InfoTip text={tip} />}
      {children}
    </span>
  );
}

function StepCard({ title, subtitle, icon: Icon, children }) {
  return (
    <div style={stepCard}>
      <div style={stepHeader}>
        <div style={stepIcon}>{Icon && <Icon size={20} />}</div>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          {subtitle && <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>{subtitle}</p>}
        </div>
      </div>
      <div style={{ padding: '0 16px 16px' }}>{children}</div>
    </div>
  );
}

// Lets every field show a mild red outline on an empty required box the
// moment the form's been "touched" (first Generate attempt, or a step-5
// validation click) — WITHOUT having to thread a `touched` prop down to
// every single field call site by hand. Fields that DO pass `touched`
// explicitly (the array/tag inputs with their own validation messages) keep
// using that value instead — see `effectiveTouched = touched ?? context`.
const FormTouchedContext = createContext(false);

function Field({ label, tip, required, error, touched, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
        {children}
      </label>
      {error && touched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

function TextInput({ label, tip, required, value, onChange, placeholder, type = 'text', error, touched, ...props }) {
  const globalTouched = useContext(FormTouchedContext);
  const effectiveTouched = touched ?? globalTouched;
  const isEmpty = required && !String(value ?? '').trim();
  const showOutline = isEmpty || (effectiveTouched && !!error);
  return (
    <Field label={label} tip={tip} required={required} error={error} touched={effectiveTouched}>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => {
          // A DOM <input type="number"> value is ALWAYS a string — passing it
          // straight through left tripInput.pricePerPerson/durationDays/etc.
          // as strings, which the backend's Number.isFinite(v) check rejects
          // even when the field is visibly filled. Coerce here, once, for
          // every numeric field site-wide.
          if (type === 'number') { onChange(e.target.value === '' ? '' : Number(e.target.value)); return; }
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        style={{ ...inputStyle, borderColor: showOutline ? '#e06a5a' : 'var(--border-color)' }}
        {...props}
      />
    </Field>
  );
}

function TextArea({ label, tip, required, value, onChange, placeholder, rows = 3, error, touched, aiDraft, ...props }) {
  const globalTouched = useContext(FormTouchedContext);
  const effectiveTouched = touched ?? globalTouched;
  const isEmpty = required && !String(value ?? '').trim();
  const showOutline = isEmpty || (effectiveTouched && !!error);
  return (
    <Field label={label} tip={tip} required={required} error={error} touched={effectiveTouched}>
      <div style={{ position: 'relative' }}>
        <textarea
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          style={{ ...inputStyle, minHeight: rows * 22, fontFamily: 'inherit', resize: 'vertical', borderColor: showOutline ? '#e06a5a' : 'var(--border-color)', paddingRight: aiDraft ? 100 : 14 }}
          {...props}
        />
        {aiDraft && (
          <div style={{ position: 'absolute', top: 8, right: 8 }}>
            {aiDraft}
          </div>
        )}
      </div>
    </Field>
  );
}

function Select({ label, tip, required, value, onChange, options, error, touched, ...props }) {
  const globalTouched = useContext(FormTouchedContext);
  const effectiveTouched = touched ?? globalTouched;
  const isEmpty = required && !String(value ?? '').trim();
  const showOutline = isEmpty || (effectiveTouched && !!error);
  return (
    <Field label={label} tip={tip} required={required} error={error} touched={effectiveTouched}>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...selectStyle, borderColor: showOutline ? '#e06a5a' : 'var(--border-color)' }}
        {...props}
      >
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </Field>
  );
}

const POPULAR_DESTINATIONS = [
  'Manali', 'Shimla', 'Leh', 'Ladakh', 'Jaipur', 'Udaipur', 'Jodhpur', 'Rishikesh', 'Haridwar',
  'Agra', 'Varanasi', 'Delhi', 'Mumbai', 'Goa', 'Kerala', 'Munnar', 'Alleppey', 'Kochi',
  'Bangalore', 'Mysore', 'Ooty', 'Kodaikanal', 'Pondicherry', 'Chennai', 'Kolkata', 'Darjeeling',
  'Gangtok', 'Sikkim', 'Shillong', 'Kaziranga', 'Andaman', 'Havelock', 'Neil Island',
  'Dubai', 'Abu Dhabi', 'Singapore', 'Malaysia', 'Kuala Lumpur', 'Thailand', 'Bangkok', 'Phuket',
  'Bali', 'Indonesia', 'Vietnam', 'Hanoi', 'Ho Chi Minh City', 'Cambodia', 'Siem Reap',
  'Japan', 'Tokyo', 'Kyoto', 'Osaka', 'Hakone', 'Hiroshima', 'South Korea', 'Seoul',
  'London', 'Paris', 'Rome', 'Barcelona', 'Amsterdam', 'Switzerland', 'Zurich', 'Interlaken',
  'New York', 'Washington DC', 'Orlando', 'Los Angeles', 'San Francisco', 'Las Vegas',
  'Australia', 'Sydney', 'Melbourne', 'New Zealand', 'Auckland', 'Queenstown',
  'Egypt', 'Cairo', 'Turkey', 'Istanbul', 'Greece', 'Athens', 'Santorini',
];

// Real, worldwide place search (backed by /api/geocode — the same OSM-derived
// proxy the Itinerary map picker uses) merged with an instant local shortlist
// of frequently-used destinations, so suggestions appear immediately while the
// live geocoded results are still loading. Debounced so every keystroke
// doesn't hit the backend.
// `quickPicks` (e.g. the trip's own Route/Overnight cities) always come
// first and show even before the user types — the common case on a day card
// is picking a city already used elsewhere in the trip, not discovering a
// new one.
function useCitySuggestions(query, excludeLabels = [], quickPicks = []) {
  const [liveResults, setLiveResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setLiveResults([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      const results = await geocodeSuggest(q, 6);
      setLiveResults(results);
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set(excludeLabels.map((x) => String(x).toLowerCase()));
    const out = [];
    quickPicks.filter((d) => !q || d.toLowerCase().includes(q)).forEach((d) => {
      const key = d.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(d); }
    });
    if (!q) return out.slice(0, 8);
    POPULAR_DESTINATIONS.filter((d) => d.toLowerCase().includes(q)).forEach((d) => {
      const key = d.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(d); }
    });
    liveResults.forEach((r) => {
      const label = [r.city || r.name, r.state, r.country].filter(Boolean).join(', ') || r.display_name;
      if (!label) return;
      const key = label.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(label); }
    });
    return out.slice(0, 8);
  }, [query, liveResults, excludeLabels, quickPicks]);

  return { suggestions, loading };
}

// Single-value place field with the same live geocoded search as the
// multi-city inputs (e.g. "Destination and country"). Still a free-text
// field — picking a suggestion just fills it in faster and more accurately
// than typing the full "City, Country" string by hand. `quickPicks` (e.g.
// cities already named elsewhere in this trip) are offered first, even
// before the live/worldwide search kicks in.
// Bare (unlabeled) location autocomplete — for dense rows (hotel/overnight-city
// tables) where a full labeled Field would break the row layout. Same live
// geocoded search + quickPicks priority as PlaceInput, which wraps this.
function InlinePlaceInput({ value, onChange, placeholder, quickPicks = [], hasError, wrapperStyle, dataTestId }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const { suggestions, loading } = useCitySuggestions(value || '', [], quickPicks);

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      {loading ? (
        <Loader size={14} className="anim-spin" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
      ) : (
        <MapPin size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
      )}
      <input
        type="text"
        value={value || ''}
        onChange={(e) => { onChange(e.target.value); setShowSuggestions(true); }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
        placeholder={placeholder || 'Search a city…'}
        style={{ ...inputStyle, paddingLeft: 30, borderColor: hasError ? '#e06a5a' : 'var(--border-color)' }}
        data-testid={dataTestId}
      />
      {showSuggestions && suggestions.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(s); setShowSuggestions(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}
            >
              <MapPin size={14} style={{ color: 'var(--text-secondary)' }} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlaceInput({ label, tip, required, value, onChange, placeholder, error, touched, dataTestId, quickPicks = [] }) {
  const globalTouched = useContext(FormTouchedContext);
  const effectiveTouched = touched ?? globalTouched;
  const isEmpty = required && !String(value ?? '').trim();
  const showOutline = isEmpty || (effectiveTouched && !!error);
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
      </label>
      <InlinePlaceInput value={value} onChange={onChange} placeholder={placeholder} quickPicks={quickPicks} dataTestId={dataTestId} hasError={showOutline} />
      {error && effectiveTouched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

// A text field that's ALSO a dropdown: free typing always works (never
// restricted to the list), but picking a saved answer is one click instead
// of re-typing the same phrase every trip. Typing something new and pressing
// Enter saves it into the dropdown permanently (per-browser, via
// localStorage) — with its own delete (×) button next to it in the list, so
// the saved set stays exactly what the user actually wants to reuse. The
// curated `presets` are always offered and can never be deleted.
//
// `multi`: for fields that are really a comma-joined list in one string
// (e.g. "Curriculum connection": "Geography, History") — picking an option
// APPENDS it after the last comma instead of replacing the whole value, and
// matching/saving operates on the in-progress segment after the last comma.
// An optional block that stays collapsed (and clears its value) until the
// operator explicitly opts in — so an untouched optional colour list can never
// silently steer the theme, and it's obvious at a glance whether it's active.
function ToggleSection({ label, tip, enabled, onToggle, children }) {
  return (
    <div style={{ marginBottom: 16, minWidth: 0 }}>
      <label
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 42,
          padding: '9px 12px',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          background: 'var(--subtle-bg)',
          color: 'var(--text-primary)',
          fontSize: 14,
          fontWeight: 500,
          cursor: 'pointer',
          boxSizing: 'border-box',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ margin: 0, flexShrink: 0 }}
        />
        <LabelWithInfo label={label} tip={tip} />
      </label>
      {enabled && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

// Meal totals are ALREADY captured per day by the B/L/D checkboxes on the
// itinerary step — re-typing them here was pure duplicate data entry, and any
// drift between the two made the brochure contradict its own day plan. These
// are derived, display-only mirrors of that single source of truth.
function DerivedMealCount({ label, tip, count, noun, plural }) {
  const word = count === 1 ? noun : (plural || `${noun}s`);
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} />
      </label>
      <div
        style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--subtle-bg)', color: count ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'default' }}
        aria-readonly="true"
      >
        <span>{count ? `${count} ${word}` : `No ${plural || `${noun}s`} ticked yet`}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>from itinerary</span>
      </div>
    </div>
  );
}

function SmartComboInput({ label, tip, required, value, onChange, fieldKey, presets, placeholder, error, touched, multi, dataTestId }) {
  const [customOptions, setCustomOptions] = useState(() => loadComboCustomOptions(fieldKey));
  const [open, setOpen] = useState(false);
  const globalTouched = useContext(FormTouchedContext);
  const effectiveTouched = touched ?? globalTouched;
  const isEmpty = required && !String(value ?? '').trim();
  const showOutline = isEmpty || (effectiveTouched && !!error);

  const allOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    presets.forEach((p) => { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ label: p, custom: false }); } });
    customOptions.forEach((p) => { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ label: p, custom: true }); } });
    return out;
  }, [presets, customOptions]);

  // MULTI mode is a true multi-select: the committed picks live as chips and
  // the text box only ever holds the in-progress term, so choosing a second
  // option never has to round-trip through hand-editing a comma string (the
  // old behaviour, which made these fields read as single-value).
  const selected = useMemo(
    () => (multi ? String(value || '').split(',').map((s) => s.trim()).filter(Boolean) : []),
    [multi, value],
  );
  const selectedKeys = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

  const [draft, setDraft] = useState('');
  const segment = multi ? draft.trim() : String(value || '').trim();
  const segmentLower = segment.toLowerCase();
  const filtered = useMemo(
    () => (segmentLower ? allOptions.filter((o) => o.label.toLowerCase().includes(segmentLower)) : allOptions),
    [allOptions, segmentLower],
  );

  const persistCustom = (optLabel) => {
    const trimmed = optLabel.trim();
    if (!trimmed || allOptions.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) return;
    const next = [...customOptions, trimmed];
    setCustomOptions(next);
    saveComboCustomOptions(fieldKey, next);
  };

  // Multi: toggle the option in/out of the selection and KEEP the menu open so
  // several can be picked in one go. Single: replace and close, as before.
  const applyOption = (optLabel) => {
    if (multi) {
      const key = optLabel.toLowerCase();
      const next = selectedKeys.has(key)
        ? selected.filter((s) => s.toLowerCase() !== key)
        : [...selected, optLabel];
      onChange(next.join(', '));
      setDraft('');
    } else {
      onChange(optLabel);
      setOpen(false);
    }
  };

  const removeSelected = (optLabel) => {
    const key = optLabel.toLowerCase();
    onChange(selected.filter((s) => s.toLowerCase() !== key).join(', '));
  };

  const removeCustom = (optLabel) => {
    const next = customOptions.filter((o) => o.toLowerCase() !== optLabel.toLowerCase());
    setCustomOptions(next);
    saveComboCustomOptions(fieldKey, next);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
      </label>
      {multi && selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map((tag) => (
            <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 16, background: 'var(--subtle-bg-3)', fontSize: 13, color: 'var(--text-primary)' }}>
              {tag}
              <button
                type="button"
                onClick={() => removeSelected(tag)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 0 }}
                aria-label={`Remove ${tag}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={multi ? draft : (value || '')}
          onChange={(e) => { if (multi) setDraft(e.target.value); else onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && segment) {
              e.preventDefault();
              persistCustom(segment);
              applyOption(segment);
            } else if (multi && e.key === 'Backspace' && !draft && selected.length) {
              // Empty box + Backspace removes the last chip — standard tag-input behaviour.
              e.preventDefault();
              removeSelected(selected[selected.length - 1]);
            }
          }}
          placeholder={placeholder || (multi ? 'Type or pick — choose as many as you like' : 'Type or pick from the list')}
          style={{ ...inputStyle, paddingRight: 30, borderColor: showOutline ? '#e06a5a' : 'var(--border-color)' }}
          data-testid={dataTestId}
        />
        <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
        {open && filtered.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
            {filtered.map((o) => {
              const isOn = multi && selectedKeys.has(o.label.toLowerCase());
              return (
                <div key={o.label} style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border-color)' }}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); applyOption(o.label); }}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', textAlign: 'left', background: isOn ? 'var(--subtle-bg-3)' : 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-primary)' }}
                  >
                    {multi && (
                      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border-color)', background: isOn ? 'var(--primary-color, var(--accent-color))' : 'transparent', color: '#fff', fontSize: 10, lineHeight: 1, flexShrink: 0 }}>
                        {isOn ? '✓' : ''}
                      </span>
                    )}
                    {o.label}
                  </button>
                  {o.custom && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); removeCustom(o.label); }}
                      style={{ padding: '0 10px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
                      aria-label={`Remove "${o.label}" from saved options`}
                      title="Remove from saved options"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {error && effectiveTouched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

function LocationTagInput({ label, tip, required, value, onChange, placeholder, error, touched, dataTestId }) {
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const tags = useMemo(() => {
    if (!value) return [];
    return value.split('→').map((s) => s.trim()).filter(Boolean);
  }, [value]);

  const { suggestions, loading: suggestLoading } = useCitySuggestions(query, tags);

  const addTag = (tag) => {
    if (!tag.trim()) return;
    const next = [...tags, tag.trim()];
    onChange(next.join(' → '));
    setQuery('');
    setShowSuggestions(false);
  };

  const removeTag = (idx) => {
    const next = tags.filter((_, i) => i !== idx);
    onChange(next.join(' → '));
  };

  const moveTag = (idx, dir) => {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= tags.length) return;
    const next = [...tags];
    const tmp = next[idx];
    next[idx] = next[nextIdx];
    next[nextIdx] = tmp;
    onChange(next.join(' → '));
  };

  const clearAll = () => {
    onChange('');
  };

  return (
    <div style={{ marginBottom: 16, position: 'relative' }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
      </label>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          {tags.map((tag, i) => (
            <span key={`${tag}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 16, background: 'var(--subtle-bg-3)', fontSize: 13, color: 'var(--text-primary)' }}>
              <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)' }}>{i + 1}.</span>
              <span>{tag}</span>
              <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => moveTag(i, -1)}
                  disabled={i === 0}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 2, opacity: i === 0 ? 0.4 : 1 }}
                  aria-label={`Move ${tag} up`}
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => moveTag(i, 1)}
                  disabled={i === tags.length - 1}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 2, opacity: i === tags.length - 1 ? 0.4 : 1 }}
                  aria-label={`Move ${tag} down`}
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => removeTag(i)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 2 }}
                  aria-label={`Remove ${tag}`}
                >
                  <X size={12} />
                </button>
              </span>
            </span>
          ))}
          {tags.length > 1 && (
            <button
              type="button"
              onClick={clearAll}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12, textDecoration: 'underline', padding: 4 }}
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        {suggestLoading ? (
          <Loader size={16} className="anim-spin" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
        ) : (
          <MapPin size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              e.preventDefault();
              addTag(query);
            }
          }}
          placeholder={placeholder || 'Search a city and press Enter'}
          style={{ ...inputStyle, paddingLeft: 36, borderColor: (required && tags.length === 0) || (error && touched) ? '#e06a5a' : 'var(--border-color)' }}
          data-testid={dataTestId}
        />
        {showSuggestions && suggestions.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}
              >
                <MapPin size={14} style={{ color: 'var(--text-secondary)' }} />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && touched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

// Hex-colour list (School brand colours / Preferred colours / Colours to
// avoid) — a native colour picker + hex text box, each entry shown as a
// swatch chip. Simpler and more reliable than free-typed hex codes.
// Defaults match what the cover renders when no placement has been chosen —
// so the moment the editor is shown, the preview and the eventual brochure
// agree exactly (no hidden "AI decides differently" gap between what's shown
// and what ships).
const TMC_LOGO_DEFAULT = { x: 0.3, y: 0.12, scale: 1 };
const SCHOOL_LOGO_DEFAULT = { x: 0.7, y: 0.12, scale: 1 };

function LogoSlider({ label, value, min, max, step, onChange, format }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>
        <span>{label}</span>
        <span>{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} />
    </div>
  );
}

const LOGO_POSITION_PRESETS = [
  { label: 'Top left', x: 0.22, y: 0.12 },
  { label: 'Top center', x: 0.5, y: 0.12 },
  { label: 'Top right', x: 0.78, y: 0.12 },
  { label: 'Bottom left', x: 0.22, y: 0.85 },
  { label: 'Bottom center', x: 0.5, y: 0.85 },
  { label: 'Bottom right', x: 0.78, y: 0.85 },
];

// Real, live logo size/position control for the TMC-school cover — both
// logos independently draggable-by-slider with a genuine WYSIWYG preview
// (actual uploaded logo images, at their actual chosen position and size).
// The engine (deterministic fallback AND the AI design brief) is told these
// EXACT values and must honor them, so what's shown here is what ships.
function LogoPlacementEditor({ brand, setBrand, heroPreviewUrl, tripTitle }) {
  const tmcPlacement = brand.tmcLogoPlacement || TMC_LOGO_DEFAULT;
  const schoolPlacement = brand.schoolLogoPlacement || SCHOOL_LOGO_DEFAULT;
  const updateTmc = (patch) => setBrand((b) => ({ ...b, tmcLogoPlacement: { ...(b.tmcLogoPlacement || TMC_LOGO_DEFAULT), ...patch } }));
  const updateSchool = (patch) => setBrand((b) => ({ ...b, schoolLogoPlacement: { ...(b.schoolLogoPlacement || SCHOOL_LOGO_DEFAULT), ...patch } }));

  return (
    <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)' }}>
      <label style={{ ...fieldLabel, marginBottom: 8 }}>
        <LabelWithInfo label="Logo placement & size" tip="Move the sliders to position and size each logo on the cover — the preview updates live, and the brochure will use these exact values." />
      </label>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 auto' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Cover preview</span>
          <div
            style={{
              position: 'relative', width: 210, height: 297, borderRadius: 6, border: '1px solid var(--border-color)', overflow: 'hidden',
              background: heroPreviewUrl ? `url(${heroPreviewUrl}) center / cover` : 'linear-gradient(160deg, #1AAFE0, #0E7FA6)',
            }}
          >
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(15,23,42,.55), rgba(15,23,42,.15) 45%, rgba(15,23,42,.72))' }} />
            {tripTitle && (
              <div style={{ position: 'absolute', left: 16, right: 16, bottom: 40, color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.2, textShadow: '0 2px 6px rgba(0,0,0,.6)' }}>{tripTitle}</div>
            )}
            {brand.logoUrl && (
              <img
                src={brand.logoUrl}
                alt="Agency logo"
                style={{
                  position: 'absolute', left: `${tmcPlacement.x * 100}%`, top: `${tmcPlacement.y * 100}%`, transform: 'translate(-50%, -50%)',
                  height: `${28 * tmcPlacement.scale}px`, width: 'auto', maxWidth: '55%', objectFit: 'contain', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.5))',
                }}
              />
            )}
            {brand.schoolLogoUrl && (
              <img
                src={brand.schoolLogoUrl}
                alt="School logo"
                style={{
                  position: 'absolute', left: `${schoolPlacement.x * 100}%`, top: `${schoolPlacement.y * 100}%`, transform: 'translate(-50%, -50%)',
                  height: `${30 * schoolPlacement.scale}px`, width: 'auto', maxWidth: '55%', objectFit: 'contain', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.5))',
                }}
              />
            )}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 210, marginTop: 6 }}>
            Approximate background/typography — the final design&apos;s exact style is chosen by the engine, but logo position and size will match this exactly.
          </p>
        </div>

        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          {brand.logoUrl && (
            <div style={{ marginBottom: 18 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Agency (TMC) logo</span>
              <LogoSlider label="Horizontal position" value={tmcPlacement.x} min={0} max={1} step={0.01} onChange={(v) => updateTmc({ x: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <LogoSlider label="Vertical position" value={tmcPlacement.y} min={0} max={1} step={0.01} onChange={(v) => updateTmc({ y: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <LogoSlider label="Size" value={tmcPlacement.scale} min={0.5} max={2} step={0.05} onChange={(v) => updateTmc({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {LOGO_POSITION_PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => updateTmc({ x: p.x, y: p.y })} style={chipBtn}>{p.label}</button>
                ))}
              </div>
            </div>
          )}
          {brand.schoolLogoUrl && (
            <div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>School logo</span>
              <LogoSlider label="Horizontal position" value={schoolPlacement.x} min={0} max={1} step={0.01} onChange={(v) => updateSchool({ x: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <LogoSlider label="Vertical position" value={schoolPlacement.y} min={0} max={1} step={0.01} onChange={(v) => updateSchool({ y: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <LogoSlider label="Size" value={schoolPlacement.scale} min={0.5} max={2} step={0.05} onChange={(v) => updateSchool({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {LOGO_POSITION_PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => updateSchool({ x: p.x, y: p.y })} style={chipBtn}>{p.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Neutral placeholder for the "not yet chosen" draft swatch — TMC's own brand
// cyan was used here before, which made an untouched/uncommitted draft look
// exactly like "the app already picked TMC's colour for you", and made a
// typed-but-never-added colour reverting to it on blur look like a genuine
// bug rather than an empty draft.
const COLOR_DRAFT_DEFAULT = '#888888';

function ColorTagInput({ label, tip, items, onAdd, onRemove }) {
  const [draft, setDraft] = useState(COLOR_DRAFT_DEFAULT);
  // Typing a colour into this box does NOT save it — only "+ Add colour" /
  // Enter does. A colour typed and then left (clicking Next, clicking away)
  // without that explicit step was silently discarded, which read as "my
  // colour choice reverted" even though it was never actually added. `dirty`
  // tracks whether the user has touched the draft since the last commit, so
  // leaving the field (blur) now commits a valid pending colour automatically
  // instead of losing it — guarded by `dirty` so the auto-reset after a
  // successful commit can't re-fire and add a duplicate.
  const [dirty, setDirty] = useState(false);

  const commitDraft = () => {
    if (!dirty) return;
    const v = draft.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) onAdd(v);
    setDraft(COLOR_DRAFT_DEFAULT);
    setDirty(false);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {label ? (
        <label style={fieldLabel}>
          <LabelWithInfo label={label} tip={tip} />
        </label>
      ) : null}
      {(items || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {(items || []).map((hex, i) => (
            <span key={`${hex}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 16, background: 'var(--subtle-bg-3)', fontSize: 13, color: 'var(--text-primary)' }}>
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: hex, border: '1px solid var(--border-color)' }} />
              {hex}
              <button type="button" onClick={() => onRemove(i)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 0 }} aria-label={`Remove ${hex}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : COLOR_DRAFT_DEFAULT}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          onBlur={commitDraft}
          style={{ width: 40, height: 36, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' }}
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitDraft(); }
          }}
          onBlur={commitDraft}
          placeholder="#1AAFE0"
          style={{ ...inputStyle, width: 120 }}
        />
        <button type="button" onClick={commitDraft} style={chipBtn}>
          + Add colour
        </button>
      </div>
    </div>
  );
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

// The single accent colour used throughout the brochure — always live (no
// separate "auto vs manual" mode to remember to flip), defaults to TMC's own
// Classroom Cyan, and is what the render engine actually uses (see
// tmcAccent()/tmcSecondary() in the engine — this is the authoritative
// source once a destination-theme "Manual palette" isn't separately set in
// the Theme step). A second colour is optional — adding one blends the two
// as a two-stop gradient wherever the brochure uses a gradient treatment.
function BrochureAccentPicker({ accent, accentSecondary, onAccentChange, onAccentSecondaryChange, kitColorChoices }) {
  const safeAccent = HEX_RE.test(accent || '') ? accent : '#1AAFE0';
  const hasSecondary = HEX_RE.test(accentSecondary || '');
  const safeSecondary = hasSecondary ? accentSecondary : safeAccent;

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo
          label="Brochure colour accent"
          tip="The accent colour used throughout the brochure. Defaults to TMC's own Classroom Cyan — change it any time. Optionally add a second colour to blend the two as a gradient."
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={safeAccent}
            onChange={(e) => onAccentChange(e.target.value)}
            style={{ width: 40, height: 36, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' }}
          />
          <input
            type="text"
            value={accent || ''}
            onChange={(e) => onAccentChange(e.target.value)}
            placeholder="#1AAFE0"
            style={{ ...inputStyle, width: 100 }}
            data-testid="input-brochureAccent"
          />
        </div>
        {hasSecondary ? (
          <>
            <div
              aria-hidden="true"
              style={{ width: 60, height: 20, borderRadius: 10, background: `linear-gradient(90deg, ${safeAccent}, ${safeSecondary})`, border: '1px solid var(--border-color)' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="color"
                value={safeSecondary}
                onChange={(e) => onAccentSecondaryChange(e.target.value)}
                style={{ width: 40, height: 36, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' }}
              />
              <input
                type="text"
                value={accentSecondary || ''}
                onChange={(e) => onAccentSecondaryChange(e.target.value)}
                placeholder="#000000"
                style={{ ...inputStyle, width: 100 }}
                data-testid="input-brochureAccentSecondary"
              />
            </div>
            <button type="button" onClick={() => onAccentSecondaryChange('')} style={chipBtn}>
              Remove gradient
            </button>
          </>
        ) : (
          <button type="button" onClick={() => onAccentSecondaryChange(safeAccent)} style={chipBtn}>
            + Add second colour (gradient)
          </button>
        )}
      </div>
      {kitColorChoices?.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>From brand kit:</span>
          {kitColorChoices.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => onAccentChange(c.hex)}
              title={`Use ${c.label.toLowerCase()} (${c.hex}) as the brochure accent`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 16, border: '1px solid var(--border-color)', background: 'var(--subtle-bg-3)', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)' }}
            >
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: c.hex, border: '1px solid var(--border-color)' }} />
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// `withLocationSearch` swaps the plain add-box for a live geocoded search —
// use it for any tag list that's actually a list of PLACES (day-visit spots,
// map markers, locations to exclude), not for non-place tag lists.
function TagArrayInput({ label, tip, items, onAdd, onRemove, placeholder, withLocationSearch }) {
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const { suggestions, loading } = useCitySuggestions(withLocationSearch ? query : '', items || []);

  const addTag = (tag) => {
    if (!tag.trim()) return;
    onAdd(tag.trim());
    setQuery('');
    setShowSuggestions(false);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} />
      </label>
      {(items || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {(items || []).map((tag, i) => (
            <span key={`${tag}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 16, background: 'var(--subtle-bg-3)', fontSize: 13, color: 'var(--text-primary)' }}>
              {tag}
              <button
                type="button"
                onClick={() => onRemove(i)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', padding: 0 }}
                aria-label={`Remove ${tag}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        {withLocationSearch && (
          loading ? (
            <Loader size={14} className="anim-spin" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          ) : (
            <MapPin size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
          )
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              e.preventDefault();
              addTag(query);
            }
          }}
          placeholder={placeholder || (withLocationSearch ? 'Search a place and press Enter' : 'Type and press Enter')}
          style={withLocationSearch ? { ...inputStyle, paddingLeft: 30 } : inputStyle}
        />
        {withLocationSearch && showSuggestions && suggestions.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}
              >
                <MapPin size={14} style={{ color: 'var(--text-secondary)' }} />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OvernightCitiesInput({ label, tip, required, items, onAdd, onRemove, onChange, error, touched }) {
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const existingCities = useMemo(() => (items || []).map((c) => c.city).filter(Boolean), [items]);
  const { suggestions, loading: suggestLoading } = useCitySuggestions(query, existingCities);

  const addCity = (city) => {
    if (!city.trim()) return;
    onAdd({ city: city.trim(), nights: 1 });
    setQuery('');
    setShowSuggestions(false);
  };

  return (
    <div style={{ marginBottom: 16, position: 'relative' }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
      </label>
      {(items || []).map((city, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <InlinePlaceInput value={city.city || ''} onChange={(v) => onChange(i, { ...city, city: v })} placeholder="City" wrapperStyle={{ flex: 1 }} dataTestId={`input-overnightCities-${i}`} hasError={!String(city.city || '').trim()} />
          <input type="number" value={city.nights || ''} onChange={(e) => onChange(i, { ...city, nights: Number(e.target.value) })} placeholder="Nights" style={{ ...inputStyle, width: 100 }} />
          <button type="button" onClick={() => onRemove(i)} style={iconBtn}><X size={14} /></button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault();
                addCity(query);
              }
            }}
            placeholder="Search and add a city"
            style={{ ...inputStyle, paddingRight: suggestLoading ? 34 : undefined, borderColor: required && (items || []).length === 0 ? '#e06a5a' : 'var(--border-color)' }}
          />
          {suggestLoading && (
            <Loader size={14} className="anim-spin" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          )}
          {showSuggestions && suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, marginTop: 4, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); addCity(s); }}
                  style={{ display: 'block', width: '100%', padding: '10px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => addCity(query)} style={{ ...secondaryBtn, flex: '0 0 auto' }}>+ Add city</button>
      </div>
      {error && touched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

function ArrayText({ label, tip, required, items, onAdd, onRemove, onChange, error, touched, addLabel = 'Add item', path }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldLabel}>
        <LabelWithInfo label={label} tip={tip} required={required} />
      </label>
      {(items || []).map((val, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            value={val || ''}
            onChange={(e) => onChange(i, e.target.value)}
            style={{ ...inputStyle, flex: 1, borderColor: (required && !String(val || '').trim()) || (error && touched) ? '#e06a5a' : 'var(--border-color)' }}
            data-testid={path ? `input-${path.replace(/\./g, '-')}-${i}` : undefined}
          />
          <button type="button" onClick={() => onRemove(i)} style={iconBtn} aria-label="Remove">
            <X size={14} />
          </button>
        </div>
      ))}
      <button type="button" onClick={onAdd} style={chipBtn}>
        + {addLabel}
      </button>
      {error && touched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{error}</span>}
    </div>
  );
}

function DayCard({ day, index, updateDay, removeDay, toggleMeal, disabled, canRemove, cityOptions, onCopyOvernightFromPrevious }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Day {day.dayNumber}</span>
        <input type="date" value={day.date || ''} onChange={(e) => updateDay(index, 'date', e.target.value)} style={{ ...inputStyle, width: 140, borderColor: day.date ? 'var(--border-color)' : '#e06a5a' }} />
        <button type="button" onClick={() => setExpanded((v) => !v)} style={{ ...chipBtn, marginLeft: 'auto' }}>
          {expanded ? 'Less' : 'More details'}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button type="button" onClick={() => removeDay(index)} style={iconBtn} disabled={disabled || !canRemove} aria-label="Remove day"><X size={14} /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
        <PlaceInput label="Route" tip="Route or location for this day, e.g. &quot;Tokyo → Hakone&quot;." required value={day.route} onChange={(v) => updateDay(index, 'route', v)} quickPicks={cityOptions} placeholder="Search a city…" dataTestId={`input-days[${index}]-route`} />
        <div>
          <PlaceInput label="Overnight city" tip="City where the group sleeps this night — required for the day-by-day page and the overnight-cities summary. Cities already used elsewhere in this trip are suggested first." required value={day.overnightCity} onChange={(v) => updateDay(index, 'overnightCity', v)} quickPicks={cityOptions} placeholder="Search a city…" dataTestId={`input-days[${index}]-overnightCity`} />
          {onCopyOvernightFromPrevious && (
            <button type="button" onClick={onCopyOvernightFromPrevious} style={{ ...rawToggleBtn, marginTop: -10, marginBottom: 8 }}>
              Same city as previous day
            </button>
          )}
        </div>
      </div>
      <TextArea label="Activities" tip="Activities and visits for this day — the main content of the itinerary page." required value={day.activities} onChange={(v) => updateDay(index, 'activities', v)} rows={3} data-testid={`input-days[${index}]-activities`} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, marginBottom: expanded ? 0 : 8 }}>
        <span style={{ fontSize: 13 }}>Meals:</span>
        {['B', 'L', 'D'].map((m) => (
          <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={(day.meals || []).includes(m)} onChange={() => toggleMeal(index, m)} />
            {m === 'B' ? 'Breakfast' : m === 'L' ? 'Lunch' : 'Dinner'}
          </label>
        ))}
      </div>
      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px dashed var(--border-color)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0 12px' }}>
            <TextInput label="Departure time" tip="When the group leaves this location (optional, 24h clock)." type="time" value={day.departureTime} onChange={(v) => updateDay(index, 'departureTime', v)} />
            <TextInput label="Arrival time" tip="When the group arrives at the next location (optional, 24h clock)." type="time" value={day.arrivalTime} onChange={(v) => updateDay(index, 'arrivalTime', v)} />
            <TextInput label="Travel duration" tip="How long this day’s travel segment takes, e.g. &quot;2h 30m&quot;." value={day.travelDuration} onChange={(v) => updateDay(index, 'travelDuration', v)} placeholder="2h 30m" />
            <TextInput label="Physical demands" tip="Any physical or long-travel warning for this day, e.g. &quot;3km uphill walk&quot;." value={day.physicalDemands} onChange={(v) => updateDay(index, 'physicalDemands', v)} placeholder="Moderate walking" />
          </div>
          <TextArea label="Learning takeaway" tip="The educational point of this day — what students take away from it." value={day.learningTakeaway} onChange={(v) => updateDay(index, 'learningTakeaway', v)} rows={2} placeholder="What students learn today." />
          <TextArea label="Optional activities" tip="Alternative or optional activities not included in the base price — kept separate from included activities." value={day.optionalActivities} onChange={(v) => updateDay(index, 'optionalActivities', v)} rows={2} placeholder="Activities not included in the base price." />
          <TextArea label="Items requiring separate payment" tip="Anything on this day that costs extra and isn't part of the package price." value={day.separatePaymentItems} onChange={(v) => updateDay(index, 'separatePaymentItems', v)} rows={2} placeholder="e.g. Snacks, souvenirs" />
        </div>
      )}
    </div>
  );
}

// ─── AI draft helper ───────────────────────────────────────────────────────

function AiDraftButton({ label, context, onDraft, disabled, dataTestId, maxWords = 60 }) {
  const [loading, setLoading] = useState(false);
  const notify = useNotify();

  const handleClick = async () => {
    setLoading(true);
    try {
      // mode: 'short_answer' — this is a brochure form field, not an email:
      // no greeting/sign-off/subject-line framing, plain text only. See
      // backend/routes/ai.js handleShortAnswerDraft.
      const res = await fetchApi('/api/ai/draft', {
        method: 'POST',
        body: JSON.stringify({ context, mode: 'short_answer', maxWords }),
      });
      if (res?.draft) {
        onDraft(res.draft);
        notify.success('AI draft generated. Review and edit as needed.');
      } else {
        notify.error('No draft returned.');
      }
    } catch (err) {
      notify.error(err?.message || 'Failed to generate AI draft.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || loading}
      style={{ ...chipBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      data-testid={dataTestId}
    >
      {loading ? <Loader size={12} className="anim-spin" /> : <Sparkles size={12} />}
      {label}
    </button>
  );
}

// ─── Model picker ──────────────────────────────────────────────────────────

function ModelPicker({ catalog, selectedModel, onChange, running, aiProvider, aiError }) {
  const availableModels = useMemo(() => catalog.models.filter((m) => m.available), [catalog.models]);
  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  const selected = byId.get(selectedModel || '') || null;

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, background: 'var(--surface-color)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Cpu size={16} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>AI Model</span>
      </div>
      {aiProvider && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Provider: <strong>{aiProvider.label}</strong>
        </p>
      )}
      {aiError && (
        <p style={{ fontSize: 12, color: '#e06a5a', marginBottom: 8 }}>
          {aiError.code === 'AI_CREDITS_EXHAUSTED'
            ? 'CRM-managed AI credits are exhausted. Add your own provider key or purchase more credits.'
            : 'No AI provider is configured. Set one in Settings → AI to choose models here.'}
        </p>
      )}
      <select
        value={selectedModel || ''}
        onChange={(e) => onChange(e.target.value)}
        style={selectStyle}
        disabled={running || !availableModels.length}
        data-testid="reasoning-model-select"
      >
        <option value="">{availableModels.length ? 'Select a model' : 'No models available'}</option>
        {availableModels.map((m) => (
          <option key={m.id} value={m.id}>{m.label} · {m.provider} · ${m.inputPer1M}/${m.outputPer1M}/1M</option>
        ))}
      </select>
      {selected && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          Smart {selected.intelligence}/5 · Value {selected.costEff}/5 — {selected.blurb}
        </p>
      )}
    </div>
  );
}

// ─── Itinerary import ──────────────────────────────────────────────────────

function ItineraryImport({ itineraries, selectedId, onSelect, onImport, importing, imported, disabled }) {
  return (
    <div style={importCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Upload size={20} />
        <div>
          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Start from an existing itinerary</h4>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            Pick an itinerary to auto-fill the whole form, then just review and generate.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-primary)' }}>Itinerary</label>
          <select
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            style={selectStyle}
            disabled={disabled || importing}
            data-testid="itinerary-select"
          >
            <option value="">Select an itinerary…</option>
            {itineraries.map((it) => (
              <option key={it.id} value={String(it.id)}>
                #{it.id} — {it.destination || 'Unknown'} · {formatDateLabel(it.startDate)} · {it.contact?.name || 'No contact'}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onImport}
          style={{ ...primaryBtn, width: 'auto', minWidth: 120 }}
          disabled={!selectedId || importing || disabled}
          data-testid="import-itinerary"
        >
          {importing ? <><Loader size={14} className="anim-spin" /> Filling…</> : <><ArrowRight size={14} /> Fill form</>}
        </button>
      </div>
      {imported && (
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#22863a', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle2 size={14} /> Form filled from itinerary. Review each step below and adjust anything that needs changing.
        </p>
      )}
    </div>
  );
}

// ─── Trace + result panel ──────────────────────────────────────────────────

function TraceLine({ event }) {
  if (!event) return null;
  const type = String(event.type || 'unknown');
  const agentKey = event.agentKey || event.parentAgentKey || '';
  const d = event.data || {};
  // `agent.tool_result` had NO case here, so every tool result — including the
  // "AI art direction abandoned … Reason: <why>" diagnostic — fell through to an
  // empty string and rendered as a blank row. The one line that explains why a
  // brochure came out as the plain fallback was being emitted correctly and then
  // thrown away by the viewer, which is worse than not logging it at all.
  const isError = !!(typeof d === 'object' && d && d.error);
  const dataPreview = (() => {
    if (typeof d === 'string') return d.slice(0, 400);
    if (type === 'agent.tool_call') return `→ ${String(d.tool || '')}`;
    if (type === 'agent.tool_result') {
      const tool = d.tool ? `${d.tool}: ` : '';
      if (d.error) return `✖ ${tool}${String(d.error).slice(0, 400)}`;
      return `✓ ${tool}${String(d.result ?? '').slice(0, 200)}`;
    }
    if (type === 'engine.log') return String(d.line || '').slice(0, 400);
    if (type === 'delegation.started') return `→ delegate "${String(d.task || '').slice(0, 80)}"`;
    if (type === 'usage') return `${d.model || ''} · in ${d.inputTokens ?? '?'} / out ${d.outputTokens ?? '?'} · $${Number(d.billedUsd || 0).toFixed(4)}`;
    if (type === 'run.completed') return `✓ done · pdf=${d.pdfUrl || '—'} · $${Number(d.billedUsd || 0).toFixed(4)}`;
    if (type === 'run.failed') return `✖ ${String(d.error || '')}`;
    if (type === 'agent.message' && d.final) return '✓ produced final result';
    return '';
  })();
  return (
    <div style={traceLine}>
      <span style={traceType}>{type}</span>
      {agentKey && <span style={traceAgent}>{agentKey}</span>}
      {dataPreview && (
        <span style={isError ? { ...traceData, color: '#e06a5a', whiteSpace: 'pre-wrap' } : { ...traceData, whiteSpace: 'pre-wrap' }}>
          {dataPreview}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  let bg = 'var(--subtle-bg-3)';
  let fg = 'var(--text-secondary)';
  if (status === 'completed') { bg = 'rgba(34,134,58,0.15)'; fg = '#22863a'; }
  else if (status === 'failed') { bg = 'rgba(176,0,0,0.15)'; fg = '#b00'; }
  else if (status === 'running') { bg = 'rgba(38,88,85,0.15)'; fg = 'var(--primary-color, var(--accent-color))'; }
  return (
    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>{status}</span>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function BrochureEngine() {
  const notify = useNotify();
  const draftRef = useRef(null);
  if (draftRef.current === null) draftRef.current = loadDraft() || {};
  const [restoredDraft] = useState(() => !!(draftRef.current.tripInput || draftRef.current.brand));
  const [tripInput, setTripInput] = useState(() => ({ ...emptyTripInput(), ...(draftRef.current.tripInput || {}) }));
  const [brand, setBrand] = useState(() => ({
    name: 'The Modern Classroom',
    tagline: 'TRAVEL. EXPERIENCE. LEARN.',
    logoUrl: '',
    // "Brochure colour accent" — always live (no separate auto/manual mode to
    // remember to flip): defaults to TMC's own Classroom Cyan and is sent on
    // every run, changeable any time. accentSecondary is optional — set only
    // when the operator picks a second colour to form a two-stop gradient.
    accent: '#1AAFE0',
    accentSecondary: '',
    contact: [],
    socials: [],
    qrUrl: '',
    custom: null,
    imagePool: [],
    coverLogos: [],
    interiorLogos: null,
    schoolName: '',
    schoolLogoUrl: '',
    schoolLogoFileName: '',
    schoolLogoFormat: 'png',
    schoolLogoApproved: false,
    tmcBrandKitId: '',
    schoolLogoVersion: 'full-colour',
    partnerLogos: [],
    coBrandingWording: '',
    specialLogoInstructions: '',
    tmcLogoPlacement: TMC_LOGO_DEFAULT,
    schoolLogoPlacement: SCHOOL_LOGO_DEFAULT,
    ...(draftRef.current.brand || {}),
  }));
  const [draftBannerDismissed, setDraftBannerDismissed] = useState(false);
  const [brandKits, setBrandKits] = useState([]);
  // Loading a Brand Kit brings its logo across immediately, but its colour(s)
  // are offered as pickable swatches instead of silently overwriting whatever
  // "Brochure colour accent" is currently set to — the kit's colour choice and
  // the trip's accent colour are related but not forced to be identical.
  const [brandKitColorChoices, setBrandKitColorChoices] = useState([]);
  const [catalog, setCatalog] = useState({ tiers: [], strategies: [], defaults: {}, markup: 1.5, models: [] });
  const [reasoningModel, setReasoningModel] = useState('');
  const [aiProvider, setAiProvider] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [, setActiveBrochureId] = useState(null);
  const [traceEvents, setTraceEvents] = useState([]);
  const [showRawTrace, setShowRawTrace] = useState(false);
  const [result, setResult] = useState(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const [runError, setRunError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tab, setTab] = useState('generate');
  const [step, setStep] = useState(1);
  // Every step is long enough to scroll — landing at the bottom of the PREVIOUS
  // step's content after Next/Back (rather than the top of the new step) means
  // re-scrolling up by hand every single time. Scroll back to the step
  // progress bar whenever the step actually changes.
  const goToStep = useCallback((next) => {
    setStep(next);
    requestAnimationFrame(() => {
      document.getElementById('brochure-step-progress')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);
  const [touched, setTouched] = useState(false);
  const [bulkMeals, setBulkMeals] = useState(['B', 'L', 'D']);
  // In-app replacement for window.confirm() — the native dialog renders as
  // browser chrome ("localhost:5173 says…"), which looks like the app is
  // broken/foreign rather than part of the CRM. This resolves a promise the
  // same way, so every existing `if (!window.confirm(...)) return;` call
  // site just becomes `if (!(await askConfirm(...))) return;`.
  const [confirmState, setConfirmState] = useState(null);
  const askConfirm = useCallback((message, opts = {}) => new Promise((resolve) => {
    setConfirmState({ message, resolve, confirmLabel: opts.confirmLabel || 'OK', danger: !!opts.danger, onCheckNow: opts.onCheckNow || null });
  }), []);
  const resolveConfirm = useCallback((value) => {
    setConfirmState((s) => { s?.resolve(value); return null; });
  }, []);
  // "Check now" doesn't just close the dialog — it treats the pending action
  // as cancelled (same as Cancel) AND jumps the user straight to whatever
  // needs a look, instead of leaving them to hunt for it after dismissing.
  const checkNowConfirm = useCallback(() => {
    setConfirmState((s) => { s?.onCheckNow?.(); s?.resolve(false); return null; });
  }, []);
  const [itineraries, setItineraries] = useState([]);
  const [selectedItineraryId, setSelectedItineraryId] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const esRef = useRef(null);
  const activeBrochureIdRef = useRef(null);

  // Autosave the whole form (debounced) so a refresh/tab-close/crash never
  // costs the 10+ minutes it takes to fill this in. Skipped while a run is
  // in flight so a completed/failed run's transient state doesn't overwrite
  // the draft the moment it changes.
  useEffect(() => {
    if (running) return undefined;
    const t = setTimeout(() => saveDraft(tripInput, brand), 600);
    return () => clearTimeout(t);
  }, [tripInput, brand, running]);

  // The debounce above only OPTIMIZES the common case (coalesce rapid typing
  // into one write); its cleanup only clears the pending timer, it never
  // flushes. So a change made and then navigated away from within that 600ms
  // window (switching pages, a refresh, closing the tab) was silently
  // discarded — the exact "picked a colour, came back, it's gone" bug, and it
  // applied to every field on the form, not just that one. Always keep the
  // very latest state in a ref and flush it synchronously on every exit path.
  const latestFormRef = useRef({ tripInput, brand });
  useEffect(() => {
    latestFormRef.current = { tripInput, brand };
  }, [tripInput, brand]);
  useEffect(() => {
    const flush = () => {
      if (!running) saveDraft(latestFormRef.current.tripInput, latestFormRef.current.brand);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      // Real component teardown (route change away from this page) — flush
      // whatever the debounce above hadn't gotten to yet.
      flush();
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
    // Intentionally empty deps: this registers exit-path listeners ONCE and
    // always reads the latest values via the ref, so it never needs to
    // re-subscribe on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startFresh = useCallback(async () => {
    if (!(await askConfirm('Clear everything you\'ve entered and start a new brochure from scratch?', { confirmLabel: 'Clear & start fresh', danger: true }))) return;
    clearDraft();
    setTripInput(emptyTripInput());
    setBrand((b) => ({
      ...b,
      name: 'The Modern Classroom', tagline: 'TRAVEL. EXPERIENCE. LEARN.', logoUrl: '',
      accent: '#1AAFE0', accentSecondary: '', contact: [], socials: [], qrUrl: '', custom: null, imagePool: [], coverLogos: [],
      interiorLogos: null, schoolName: '', schoolLogoUrl: '', schoolLogoFileName: '', schoolLogoFormat: 'png',
      schoolLogoApproved: false, tmcBrandKitId: '', schoolLogoVersion: 'full-colour',
      partnerLogos: [], coBrandingWording: '', specialLogoInstructions: '',
      tmcLogoPlacement: TMC_LOGO_DEFAULT, schoolLogoPlacement: SCHOOL_LOGO_DEFAULT,
    }));
    setBrandKitColorChoices([]);
    setStep(1);
    setTouched(false);
    setDraftBannerDismissed(true);
    notify.info('Started a new brochure — previous draft cleared.');
  }, [notify, askConfirm]);

  const validationErrors = useMemo(() => (touched ? validateTripInput(mergeBrandIntoTripInput(tripInput, brand)) : []), [tripInput, brand, touched]);

  // Cities already named elsewhere in the form (route + overnight cities) —
  // offered as quick picks on every day card's Route/Overnight city field via
  // a <datalist>, so re-typing the same city on every day isn't necessary.
  // Most trips have one dominant destination — hotel rows and new day cards
  // shouldn't need it re-typed/re-searched every single time. Prefers the
  // single overnight city when there's exactly one (the common case), else
  // falls back to the trip's overall destination.
  const primaryDestinationCity = useMemo(() => primaryCityOf(tripInput), [tripInput]);

  const dayCityOptions = useMemo(() => {
    const fromRoute = String(tripInput.routeCities || '').split('→').map((s) => s.trim()).filter(Boolean);
    const fromOvernights = (tripInput.overnightCities || []).map((o) => o.city).filter(Boolean);
    return [...new Set([...fromOvernights, ...fromRoute])];
  }, [tripInput.routeCities, tripInput.overnightCities]);

  // Single source of truth for meal totals: the per-day B/L/D checkboxes on the
  // itinerary step. Derived here for display AND mirrored back into the
  // breakfasts/lunches/dinners payload fields, so the operator enters them once.
  const derivedMealCounts = useMemo(() => {
    const counts = { B: 0, L: 0, D: 0 };
    for (const day of tripInput.days || []) {
      for (const m of day?.meals || []) {
        if (counts[m] != null) counts[m] += 1;
      }
    }
    return counts;
  }, [tripInput.days]);

  useEffect(() => {
    const next = {
      breakfasts: derivedMealCounts.B ? `${derivedMealCounts.B} breakfast${derivedMealCounts.B === 1 ? '' : 's'}` : '',
      lunches: derivedMealCounts.L ? `${derivedMealCounts.L} lunch${derivedMealCounts.L === 1 ? '' : 'es'}` : '',
      dinners: derivedMealCounts.D ? `${derivedMealCounts.D} dinner${derivedMealCounts.D === 1 ? '' : 's'}` : '',
    };
    setTripInput((prev) =>
      prev.breakfasts === next.breakfasts && prev.lunches === next.lunches && prev.dinners === next.dinners
        ? prev
        : { ...prev, ...next },
    );
  }, [derivedMealCounts]);

  // Optional colour steers stay OFF unless the operator turns them on (or a
  // restored draft already carries values).
  const [usePreferredColours, setUsePreferredColours] = useState(() => !!draftRef.current?.tripInput?.preferredColours);
  const [useColoursToAvoid, setUseColoursToAvoid] = useState(() => !!draftRef.current?.tripInput?.coloursToAvoid);

  // Same hex in BOTH lists is self-cancelling — surface it instead of letting
  // the operator wonder why their "preferred" colour never appears.
  const conflictingColours = useMemo(() => {
    const split = (raw) => String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const avoid = new Set(split(tripInput.coloursToAvoid));
    return [...new Set(split(tripInput.preferredColours).filter((h) => avoid.has(h)))];
  }, [tripInput.preferredColours, tripInput.coloursToAvoid]);

  const isFormValid = validationErrors.length === 0;

  const STEPS = [
    { id: 1, label: '1. Brand & School', icon: Briefcase },
    { id: 2, label: '2. Trip Identity', icon: MapPin },
    { id: 3, label: '3. Itinerary', icon: Calendar },
    { id: 4, label: '4. Logistics & Pricing', icon: CreditCard },
    { id: 5, label: '5. Review & Generate', icon: MessageSquare },
  ];

  // ─── Loaders ─────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchApi('/api/travel/brochures/models', { silent: true });
        if (data && (data.code === 'AI_NOT_CONFIGURED' || data.code === 'AI_CREDITS_EXHAUSTED')) {
          setAiError({ error: data.error || 'AI provider not configured', code: data.code });
          setAiProvider(null);
          setCatalog({ tiers: [], strategies: [], defaults: {}, markup: 1.5, models: [] });
        } else if (data && Array.isArray(data.models)) {
          setAiError(null);
          setAiProvider(data.provider || null);
          setCatalog({
            tiers: Array.isArray(data.tiers) && data.tiers.length ? data.tiers : [],
            strategies: Array.isArray(data.strategies) && data.strategies.length ? data.strategies : [],
            defaults: data.defaults || {},
            markup: Number(data.markup) > 0 ? Number(data.markup) : 1.5,
            models: data.models,
          });
          if (data.defaults?.reasoning) setReasoningModel(data.defaults.reasoning);
        }
      } catch (e) {
        if (e.code === 'AI_NOT_CONFIGURED' || e.code === 'AI_CREDITS_EXHAUSTED') {
          setAiError({ error: e.message || 'AI provider not configured', code: e.code });
          setAiProvider(null);
        } else {
          console.warn('[brochures] model catalog unavailable', e);
        }
      }
    })();
    (async () => {
      try {
        const data = await fetchApi('/api/brand-kits?fields=summary&isActive=true');
        if (data && Array.isArray(data.brandKits)) setBrandKits(data.brandKits);
      } catch (e) {
        console.warn('[brochures] brand-kit list failed', e);
      }
    })();
    (async () => {
      try {
        const data = await fetchApi('/api/travel/itineraries?fields=summary');
        if (data && Array.isArray(data.itineraries)) setItineraries(data.itineraries);
      } catch (e) {
        console.warn('[brochures] itinerary list failed', e);
      }
    })();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await fetchApi('/api/travel/brochures');
      if (data && Array.isArray(data.brochures)) setHistory(data.brochures);
    } catch (e) {
      console.warn('[brochures] history load failed', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // ─── Brand helpers ───────────────────────────────────────────────────────

  const loadBrandKitIdentity = useCallback(async (kitId) => {
    try {
      const kit = await fetchApi(`/api/brand-kits/${kitId}`);
      if (!kit || !kit.id) {
        notify.error('Failed to load brand kit identity.');
        return;
      }
      setBrand((b) => {
        const next = { ...b, tmcBrandKitId: String(kit.id) };
        const logo = kit.logoUrl || kit.logoDarkUrl || '';
        if (logo) next.logoUrl = logo;
        next.tagline = kit.tagline || b.tagline || '';
        // The kit's own colour(s) are NOT auto-applied to "Brochure colour
        // accent" — logo loads immediately, but colour is offered as a pick,
        // not forced, since the kit's saved colour and this specific trip's
        // accent are related but not necessarily meant to be identical.
        const contact = [kit.supportPhone, kit.supportEmail].filter(Boolean);
        if (contact.length) next.contact = contact;
        let networks = [];
        if (kit.socialLinksJson) {
          try {
            const parsed = JSON.parse(kit.socialLinksJson);
            if (Array.isArray(parsed)) {
              networks = parsed.map((l) => l && l.network).filter(Boolean);
            }
          } catch { /* ignore malformed socialLinksJson */ }
        }
        if (networks.length) next.socials = networks;
        return next;
      });
      const hexRe = /^#[0-9a-f]{6}$/i;
      const kitColors = [
        { label: 'Accent', hex: kit.accentColor },
        { label: 'Background', hex: kit.bgColor },
        { label: 'Text', hex: kit.textColor },
      ].filter((c) => c.hex && hexRe.test(c.hex));
      setBrandKitColorChoices(kitColors);
      notify.info(`Loaded identity from brand kit "${kit.subBrand || kit.id}".`);
    } catch (err) {
      notify.error(err?.message || 'Failed to load brand kit identity.');
    }
  }, [notify]);

  // Selecting "— none —" after a brand kit was loaded left every field that
  // load populated (logo, tagline, accent, contact, socials) stuck at the
  // previous kit's values — the select's onChange only ever handled the
  // "picked a kit" case, never "picked none". Revert to the same defaults
  // the form starts with.
  const clearBrandKitIdentity = useCallback(() => {
    setBrand((b) => ({
      ...b,
      tmcBrandKitId: '',
      logoUrl: '',
      tagline: 'TRAVEL. EXPERIENCE. LEARN.',
      accent: '#1AAFE0',
      accentSecondary: '',
      contact: [],
      socials: [],
    }));
    setBrandKitColorChoices([]);
  }, []);

  const onUploadImages = useCallback(async (files, target = 'pool') => {
    const list = files instanceof FileList || Array.isArray(files) ? Array.from(files) : (files ? [files] : []);
    const valid = [];
    for (const file of list) {
      if (file.size > 10 * 1024 * 1024) { notify.error(`"${file.name}" too large — max 10MB.`); continue; }
      if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) { notify.error(`"${file.name}" must be PNG, JPEG, WebP, or GIF.`); continue; }
      valid.push(file);
    }
    if (!valid.length) return;
    const formData = new FormData();
    valid.forEach((f) => formData.append('images', f));
    try {
      const data = await fetchApi('/api/travel/brochures/brand-images/upload', { method: 'POST', body: formData });
      const urls = Array.isArray(data?.urls) ? data.urls : [];
      if (!urls.length) { notify.error('No images were uploaded.'); return; }
      const firstFile = valid[0];
      if (target === 'school') {
        setBrand((b) => ({
          ...b,
          schoolLogoUrl: urls[0],
          schoolLogoFileName: firstFile.name,
          schoolLogoFormat: firstFile.name.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg',
          imagePool: Array.from(new Set([...(b.imagePool || []), ...urls])),
        }));
      } else if (target === 'agency') {
        setBrand((b) => ({
          ...b,
          logoUrl: urls[0],
          imagePool: Array.from(new Set([...(b.imagePool || []), ...urls])),
        }));
      } else if (target === 'partner') {
        setBrand((b) => ({ ...b, partnerLogos: [...(b.partnerLogos || []), ...urls] }));
      } else {
        setBrand((b) => ({ ...b, imagePool: [...(b.imagePool || []), ...urls] }));
      }
    } catch (_err) {
      notify.error('Failed to upload brand images.');
    }
  }, [notify]);

  // Reference documents (Source Control step) — kept for the operator's own
  // record-keeping only. There is no file-parsing pipeline for this flow, so
  // these are never read by the AI composer; the real facts still have to be
  // typed into the structured fields above.
  const onUploadReferenceFiles = useCallback(async (files) => {
    const list = files instanceof FileList || Array.isArray(files) ? Array.from(files) : (files ? [files] : []);
    if (!list.length) return;
    const formData = new FormData();
    list.forEach((f) => formData.append('files', f));
    try {
      const data = await fetchApi('/api/travel/brochures/reference-files/upload', { method: 'POST', body: formData });
      const uploaded = Array.isArray(data?.files) ? data.files : [];
      if (!uploaded.length) { notify.error('No files were uploaded.'); return; }
      setTripInput((prev) => ({ ...prev, uploadedFiles: [...(prev.uploadedFiles || []), ...uploaded] }));
    } catch (err) {
      notify.error(err?.message || 'Failed to upload reference files.');
    }
  }, [notify]);

  const removeImage = useCallback((url) => {
    setBrand((b) => {
      const imagePool = (b.imagePool || []).filter((u) => u !== url);
      const wasPrimary = b.logoUrl === url;
      const wasSchool = b.schoolLogoUrl === url;
      const logoUrl = wasPrimary ? (imagePool[0] || '') : b.logoUrl;
      let coverLogos = (b.coverLogos || []).filter((l) => l.url !== url);
      if (wasPrimary && logoUrl) coverLogos = coverLogos.filter((l) => l.url !== logoUrl);
      let interiorLogos = b.interiorLogos;
      if (interiorLogos?.items?.some((it) => it.url === url)) {
        const items = interiorLogos.items.filter((it) => it.url !== url);
        interiorLogos = items.length ? { ...interiorLogos, items } : null;
      }
      const custom = wasPrimary ? null : b.custom;
      const next = { ...b, imagePool, logoUrl, coverLogos, interiorLogos, custom };
      if (wasSchool) {
        next.schoolLogoUrl = '';
        next.schoolLogoFileName = '';
        next.schoolLogoApproved = false;
      }
      return next;
    });
    if (url && !url.startsWith('data:')) {
      fetchApi('/api/travel/brochures/brand-images/file', {
        method: 'DELETE',
        body: JSON.stringify({ url }),
      }).catch((err) => {
        console.warn('[brochures] failed to delete remote image', err);
      });
    }
  }, []);

  // ─── Trip input helpers ──────────────────────────────────────────────────

  const updateTrip = useCallback((path, value) => {
    setTripInput((prev) => {
      const keys = path.split(/\.|(\[\d+\])/).filter(Boolean);
      const next = { ...prev };
      let cur = next;
      for (let i = 0; i < keys.length - 1; i += 1) {
        const key = keys[i];
        if (/^\[\d+\]$/.test(key)) {
          const idx = Number(key.slice(1, -1));
          cur[idx] = Array.isArray(cur[idx]) ? [...cur[idx]] : { ...cur[idx] };
          cur = cur[idx];
        } else {
          cur[key] = Array.isArray(cur[key]) ? [...cur[key]] : { ...cur[key] };
          cur = cur[key];
        }
      }
      const lastKey = keys[keys.length - 1];
      if (/^\[\d+\]$/.test(lastKey)) {
        cur[Number(lastKey.slice(1, -1))] = value;
      } else {
        cur[lastKey] = value;
      }
      return next;
    });
  }, []);

  // Duration (days/nights) is derived from the date range, not a separate
  // fact to keep in sync by hand — editing either date auto-recomputes both,
  // so a user only has to think about the dates, not four linked fields.
  const updateTravelDate = useCallback((which, dateValue) => {
    setTripInput((prev) => {
      const from = which === 'from' ? dateValue : prev.travelDates?.from;
      const to = which === 'to' ? dateValue : prev.travelDates?.to;
      const next = { ...prev, travelDates: { ...prev.travelDates, [which]: dateValue } };
      if (from && to) {
        const diffDays = Math.round((new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24));
        if (Number.isFinite(diffDays) && diffDays >= 0) {
          next.durationDays = diffDays + 1;
          next.durationNights = diffDays;
        }
      }
      return next;
    });
  }, []);

  const updateDay = useCallback((idx, field, value) => {
    setTripInput((prev) => {
      const days = [...(prev.days || [])];
      days[idx] = { ...days[idx], [field]: value };
      return { ...prev, days };
    });
  }, []);

  const addDay = useCallback(() => {
    setTripInput((prev) => {
      const days = [...(prev.days || [])];
      const last = days[days.length - 1];
      const nextDate = last ? addDaysInputDate(last.date, 1) : todayInputDate();
      days.push({
        // Defaults to the previous day's overnight city — consecutive nights
        // in the same place are the common case, so this saves a re-type;
        // still fully editable (or clearable) on the new card.
        dayNumber: days.length + 1, date: nextDate, route: '', departureTime: '', arrivalTime: '', activities: '',
        meals: [], overnightCity: last?.overnightCity || primaryCityOf(prev), learningTakeaway: '', travelDuration: '', physicalDemands: '',
        optionalActivities: '', separatePaymentItems: '',
      });
      return { ...prev, days };
    });
  }, []);

  const removeDay = useCallback((idx) => {
    setTripInput((prev) => {
      const days = [...(prev.days || [])];
      days.splice(idx, 1);
      return { ...prev, days: days.map((d, i) => ({ ...d, dayNumber: i + 1 })) };
    });
  }, []);

  // Add/remove day cards so the count matches "Duration (days)" — never
  // silently drops user-entered content on days it removes; those are always
  // the trailing (highest-numbered) cards, and only when they're still blank.
  const syncDaysToDuration = useCallback(() => {
    setTripInput((prev) => {
      const target = Number(prev.durationDays) || 0;
      let days = [...(prev.days || [])];
      while (days.length < target) {
        const last = days[days.length - 1];
        const nextDate = last ? addDaysInputDate(last.date, 1) : (prev.travelDates?.from || todayInputDate());
        days.push({
          dayNumber: days.length + 1, date: nextDate, route: '', departureTime: '', arrivalTime: '', activities: '',
          meals: [], overnightCity: last?.overnightCity || primaryCityOf(prev), learningTakeaway: '', travelDuration: '', physicalDemands: '',
          optionalActivities: '', separatePaymentItems: '',
        });
      }
      while (days.length > target) {
        const trailing = days[days.length - 1];
        const isBlank = !String(trailing.route || '').trim() && !String(trailing.activities || '').trim() && !String(trailing.overnightCity || '').trim();
        if (!isBlank) break; // never discard a filled-in day — user must remove it manually
        days.pop();
      }
      return { ...prev, days };
    });
  }, []);

  const updateArrayItem = useCallback((path, idx, value) => {
    setTripInput((prev) => {
      const keys = path.split('.');
      const next = { ...prev };
      let cur = next;
      for (let i = 0; i < keys.length - 1; i += 1) {
        cur[keys[i]] = { ...cur[keys[i]] };
        cur = cur[keys[i]];
      }
      const arr = [...(cur[keys[keys.length - 1]] || [])];
      arr[idx] = value;
      cur[keys[keys.length - 1]] = arr;
      return next;
    });
  }, []);

  const addArrayItem = useCallback((path, emptyValue = '') => {
    setTripInput((prev) => {
      const keys = path.split('.');
      const next = { ...prev };
      let cur = next;
      for (let i = 0; i < keys.length - 1; i += 1) {
        cur[keys[i]] = { ...cur[keys[i]] };
        cur = cur[keys[i]];
      }
      const key = keys[keys.length - 1];
      cur[key] = [...(cur[key] || []), emptyValue];
      return next;
    });
  }, []);

  const removeArrayItem = useCallback((path, idx) => {
    setTripInput((prev) => {
      const keys = path.split('.');
      const next = { ...prev };
      let cur = next;
      for (let i = 0; i < keys.length - 1; i += 1) {
        cur[keys[i]] = { ...cur[keys[i]] };
        cur = cur[keys[i]];
      }
      const key = keys[keys.length - 1];
      const arr = [...(cur[key] || [])];
      arr.splice(idx, 1);
      cur[key] = arr;
      return next;
    });
  }, []);

  const toggleMeal = useCallback((dayIdx, meal) => {
    setTripInput((prev) => {
      const days = [...(prev.days || [])];
      const day = { ...days[dayIdx] };
      const meals = day.meals || [];
      day.meals = meals.includes(meal) ? meals.filter((m) => m !== meal) : [...meals, meal];
      days[dayIdx] = day;
      return { ...prev, days };
    });
  }, []);

  // Bulk meal selection — re-ticking B/L/D on every single day card is the
  // most common tedious case (most school trips serve the same meals every
  // day). Applies the given meal set to every day in one action.
  const setMealsForAllDays = useCallback((meals) => {
    setTripInput((prev) => ({
      ...prev,
      days: (prev.days || []).map((d) => ({ ...d, meals: [...meals] })),
    }));
  }, []);

  // ─── Itinerary import ────────────────────────────────────────────────────

  const importFromItinerary = useCallback(async () => {
    if (!selectedItineraryId) return;
    // Import REPLACES the whole trip form. Guard against silently wiping
    // minutes of manually-typed content (trip summary, objective, learning
    // outcomes, etc. — none of which any import can supply) if the user
    // imports again, or imports after already filling things in by hand.
    const hasManualContent =
      String(tripInput.tripSummary || '').trim() ||
      String(tripInput.primaryObjective || '').trim() ||
      (tripInput.learningOutcomes || []).some((x) => String(x || '').trim()) ||
      (tripInput.inclusions || []).some((x) => String(x || '').trim());
    if (hasManualContent && !(await askConfirm('Importing will replace everything currently in the form (trip summary, objectives, learning outcomes, etc. will be lost). Continue?', { confirmLabel: 'Replace it', danger: true }))) {
      return;
    }
    setImporting(true);
    setImported(false);
    try {
      const data = await fetchApi(`/api/travel/itineraries/${selectedItineraryId}`);
      const itin = data?.itinerary || data;
      if (!itin || !itin.id) {
        notify.error('Could not load itinerary details.');
        return;
      }
      const from = itin.startDate ? new Date(itin.startDate).toISOString().split('T')[0] : todayInputDate();
      const startDateTo = itin.endDate ? new Date(itin.endDate).toISOString().split('T')[0] : addDaysInputDate(from, 6);
      const daysDiffFromDates = Math.max(1, Math.ceil((new Date(startDateTo) - new Date(from)) / (1000 * 60 * 60 * 24)));
      const durationDaysFromDates = daysDiffFromDates + 1;

      const allItems = itin.items || [];
      // The itinerary's startDate/endDate can drift out of sync with its actual
      // day-by-day items (e.g. items added past the original end date without
      // the date fields being extended). Trust whichever is LONGER so an
      // itinerary with, say, 8 days of items never gets truncated to a 3-day
      // brochure just because its stored end date wasn't updated.
      const maxItemDay = allItems.reduce((max, item) => Math.max(max, item.dayNumber || 0), 0);
      const durationDays = Math.max(durationDaysFromDates, maxItemDay);
      const durationNights = Math.max(0, durationDays - 1);
      const to = durationDays > durationDaysFromDates ? addDaysInputDate(from, durationDays - 1) : startDateTo;
      if (durationDays > durationDaysFromDates) {
        notify.info(`Itinerary has ${maxItemDay} days of items — extended past its stored end date to include all of them.`);
      }

      const itemsByDay = {};
      allItems.forEach((item) => {
        const day = item.dayNumber || 1;
        if (!itemsByDay[day]) itemsByDay[day] = [];
        itemsByDay[day].push(item);
      });

      const flightItems = allItems.filter((item) => item.itemType === 'flight');
      const hotelItems = allItems.filter((item) => item.itemType === 'hotel');
      const transferItems = allItems.filter((item) => item.itemType === 'transfer');
      const visaItems = allItems.filter((item) => item.itemType === 'visa');
      const insuranceItems = allItems.filter((item) => item.itemType === 'insurance');

      // Hotels, keyed by day, so a day's overnight city/name can come from the
      // actual booked hotel rather than guessing from whichever item happens
      // to carry a locationName.
      const hotelByDay = {};
      hotelItems.forEach((item) => {
        if (item.dayNumber) hotelByDay[item.dayNumber] = item;
      });

      const days = [];
      for (let i = 1; i <= durationDays; i += 1) {
        const date = addDaysInputDate(from, i - 1);
        const items = itemsByDay[i] || [];
        // Prefer actual experiences for the day's narrative. Transfers remain
        // visible on transfer-only arrival/departure days, but do not get
        // repeated beside a real activity and again in Practical Information.
        const experienceItems = items.filter((item) => item.itemType === 'activity');
        const transferDayItems = items.filter((item) => item.itemType === 'transfer');
        const activityItems = experienceItems.length ? experienceItems : transferDayItems;
        const activities = activityItems.map((item) => {
          let text = item.description || '';
          if (item.locationName) text += ` (${item.locationName})`;
          if (item.startTime) text += ` ${item.startTime}`;
          if (item.endTime) text += `-${item.endTime}`;
          return text;
        }).join('. ');
        const dayHotel = hotelByDay[i];
        const hotelDetails = safeJsonObject(dayHotel?.detailsJson);
        const overnight = dayHotel?.locationName || hotelDetails?.city || items.find((item) => item.locationName)?.locationName || '';
        const routeLabel = overnight || activityItems[0]?.description || items[0]?.description || '';
        days.push({
          dayNumber: i,
          date,
          route: routeLabel,
          departureTime: activityItems[0]?.startTime || items[0]?.startTime || '',
          arrivalTime: activityItems[activityItems.length - 1]?.endTime || items[items.length - 1]?.endTime || '',
          activities: activities || '',
          meals: [],
          overnightCity: overnight,
          learningTakeaway: '',
          travelDuration: '',
          physicalDemands: '',
          optionalActivities: '',
          separatePaymentItems: '',
        });
      }

      // Flights: pull the richer detailsJson payload the itinerary editor
      // writes (airline, flightNumber, route.from/to — see travel_itineraries.js)
      // instead of only the human-readable description string.
      const flightDetails = flightItems.map((item) => safeJsonObject(item.detailsJson) || {});
      const firstFlight = flightDetails[0] || {};
      const lastFlight = flightDetails[flightDetails.length - 1] || {};
      const flights = {
        status: flightItems.length ? 'included' : 'na',
        airline: [...new Set(flightDetails.map((d) => d.airline).filter(Boolean))].join(', ') || flightItems[0]?.description || '',
        flightNumbers: flightDetails.map((d) => d.flightNumber).filter(Boolean).join(' / '),
        departure: [firstFlight.route?.from, firstFlight.departAt || flightItems[0]?.startTime].filter(Boolean).join(', '),
        arrival: [lastFlight.route?.to, lastFlight.arriveAt || flightItems[flightItems.length - 1]?.endTime].filter(Boolean).join(', '),
        baggage: [...new Set(flightDetails.map((d) => d.baggage).filter(Boolean))].join(', '),
      };
      const arrivalAirport = lastFlight.route?.to || '';
      const departureAirport = firstFlight.route?.from || '';

      // Hotels: category from starRating/roomType, nights from detailsJson
      // when present, otherwise counted from how many days that hotel covers.
      // City falls back to that day's overnight city when the hotel item
      // itself carries no location — an AI-drafted itinerary commonly writes
      // narrative hotel items ("Stay at the same hotel in Madurai") with the
      // city only IN the text, never as structured data.
      const dayCityByNumber = {};
      days.forEach((d) => { if (d.overnightCity) dayCityByNumber[d.dayNumber] = d.overnightCity; });
      const hotelsRaw = hotelItems.map((item) => {
        const d = safeJsonObject(item.detailsJson) || {};
        const category = [d.starRating ? `${d.starRating}★` : '', d.roomType].filter(Boolean).join(' · ');
        const city = item.locationName || d.city || (item.dayNumber ? dayCityByNumber[item.dayNumber] : '') || '';
        return { name: d.name || item.description || '', city, category, nights: Number(d.nights) || 1, _structuredName: !!d.name };
      });
      // Same-source itineraries often repeat an identical hotel line across
      // several day items (one per night) — collapse those into a single row
      // with the nights summed, instead of N duplicate "Stay at the same
      // hotel..." rows the operator would have to manually merge.
      const summarizedHotels = summarizeImportedHotels(hotelsRaw);
      const hotels = summarizedHotels.length ? summarizedHotels : [{ name: '', city: '', category: '', nights: '' }];

      // Overnight cities (Required): aggregate nights per city from the hotel
      // bookings so this field — otherwise left blank by the old importer —
      // comes pre-filled straight from what's actually booked.
      const nightsByCity = {};
      hotels.forEach((h) => {
        if (!h.city) return;
        nightsByCity[h.city] = (nightsByCity[h.city] || 0) + (Number(h.nights) || 1);
      });
      const overnightCities = Object.keys(nightsByCity).length
        ? Object.entries(nightsByCity).map(([city, nights]) => ({ city, nights }))
        : [{ city: itin.destination || '', nights: durationNights || 1 }];

      // Meals: infer Breakfasts/Lunches/Dinners counts from each hotel's
      // board (meal-plan) code, weighted by the nights actually booked there.
      const mealCounts = { breakfast: 0, lunch: 0, dinner: 0 };
      hotelItems.forEach((item) => {
        const d = safeJsonObject(item.detailsJson) || {};
        const included = BOARD_MEALS[String(d.board || '').toUpperCase()] || [];
        const nights = Number(d.nights) || 1;
        included.forEach((m) => { mealCounts[m] += nights; });
      });

      // Transport: transfer-item descriptions, bucketed by keyword since the
      // itinerary model doesn't distinguish airport/intercity/rail/local transfers.
      const transportSummary = summarizeImportedTransfers(transferItems);

      const pricePerPerson = itin.totalAmount && itin.pax ? Math.round(Number(itin.totalAmount) / Number(itin.pax)) : '';
      const depositAmount = pricePerPerson ? Math.round(pricePerPerson * 0.3) : '';

      const inclusions = safeJsonArray(itin.inclusionsJson);
      const exclusions = safeJsonArray(itin.exclusionsJson);
      const contactName = itin.contact?.name || '';
      const contactEmail = itin.contact?.email || '';

      setTripInput(() => ({
        ...emptyTripInput(),
        tripTitle: itin.title || (itin.destination ? `${itin.destination} School Trip` : ''),
        destinationCountry: itin.destination || '',
        travelDates: { from, to },
        durationDays: durationDays || 7,
        durationNights: durationNights || 6,
        expectedStudents: itin.pax || '',
        tripSummary: itin.introText || '',
        routeCities: itin.destination || '',
        overnightCities,
        arrivalAirport,
        departureAirport,
        days: days.length ? days : emptyTripInput().days,
        flights,
        airportTransfers: transportSummary.airportTransfers,
        railJourneys: transportSummary.railJourneys,
        intercityTransport: transportSummary.intercityTransport,
        hotels,
        breakfasts: mealCounts.breakfast ? `${mealCounts.breakfast} breakfasts` : '',
        lunches: mealCounts.lunch ? `${mealCounts.lunch} lunches` : '',
        dinners: mealCounts.dinner ? `${mealCounts.dinner} dinners` : '',
        inclusions: inclusions.length ? inclusions : emptyTripInput().inclusions,
        exclusions: exclusions.length ? exclusions : emptyTripInput().exclusions,
        currency: itin.currency || 'INR',
        pricePerPerson: pricePerPerson || '',
        deposit: { amount: depositAmount || '', dueDate: '' },
        cancellationTerms: itin.termsText || '',
        costStatus: {
          ...emptyTripInput().costStatus,
          visaPermit: visaItems.length ? 'included' : 'na',
          travelInsurance: insuranceItems.length ? 'included' : 'pending',
        },
        insuranceDetails: insuranceItems.map((i) => i.description).filter(Boolean).join('. '),
        primaryPhone: itin.contact?.phone || '',
        email: contactEmail,
        schoolName: itin.contact?.company || contactName || '',
        finalApprovalContact: [contactName, contactEmail].filter(Boolean).join(' — '),
      }));
      setImported(true);
      notify.success('Form filled from itinerary. Review each step and adjust as needed.');
    } catch (err) {
      notify.error(err?.message || 'Failed to import itinerary.');
    } finally {
      setImporting(false);
    }
  }, [selectedItineraryId, notify, askConfirm, tripInput.tripSummary, tripInput.primaryObjective, tripInput.learningOutcomes, tripInput.inclusions]);

  // ─── Generate ────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    setTouched(true);
    if (running) return;
    const mergedTripInput = mergeBrandIntoTripInput(tripInput, brand);
    const errors = validateTripInput(mergedTripInput);
    if (errors.length) {
      notify.error(`Please fix ${errors.length} required field${errors.length === 1 ? '' : 's'}.`);
      return;
    }
    const mismatchedPlace = detectDestinationMismatch(mergedTripInput);
    if (mismatchedPlace && !(await askConfirm(
      `Trip summary/Primary objective mentions "${mismatchedPlace}" but the destination is set to "${mergedTripInput.destinationCountry}" — this looks like leftover text from a different trip. Generate anyway?`,
      { confirmLabel: 'Generate anyway', danger: true, onCheckNow: () => goToStep(2) },
    ))) {
      return;
    }
    setRunning(true);
    setRunError(null);
    setResult(null);
    setTraceEvents([]);

    const brandPayload = {};
    if (brand.name?.trim()) brandPayload.name = brand.name.trim();
    if (brand.tagline?.trim()) brandPayload.tagline = brand.tagline.trim();
    if (brand.logoUrl) brandPayload.logoUrl = brand.logoUrl;
    // "Brochure colour accent" is always live (no auto/manual mode gate) —
    // defaults to TMC's Classroom Cyan and is sent on every run so the engine
    // always has an explicit operator-chosen accent rather than falling back
    // to whatever it derives on its own. accentSecondary rides along only
    // when the operator actually added a second colour for the gradient.
    const accentHex = /^#[0-9a-f]{6}$/i.test(brand.accent || '') ? brand.accent : '#1AAFE0';
    const accentSecondaryHex = /^#[0-9a-f]{6}$/i.test(brand.accentSecondary || '') ? brand.accentSecondary : '';
    brandPayload.colors = { accent: accentHex, ...(accentSecondaryHex ? { accentSecondary: accentSecondaryHex } : {}) };
    const contacts = (brand.contact || []).map((c) => String(c).trim()).filter(Boolean);
    if (contacts.length) brandPayload.contact = contacts;
    const socials = (brand.socials || []).map((s) => String(s).trim()).filter(Boolean);
    if (socials.length) brandPayload.socials = socials;
    if (brand.qrUrl?.trim() && /^https?:\/\//i.test(brand.qrUrl.trim())) brandPayload.qrUrl = brand.qrUrl.trim();
    if (brand.logoUrl && brand.custom) brandPayload.custom = brand.custom;
    const coverLogos = (brand.coverLogos || []).filter((l) => l && l.url);
    if (coverLogos.length) brandPayload.coverLogos = coverLogos.map((l) => ({ url: l.url, x: l.x, y: l.y, scale: l.scale }));
    if (brand.interiorLogos?.items?.length) brandPayload.interiorLogos = {
      band: brand.interiorLogos.band, scale: brand.interiorLogos.scale,
      items: brand.interiorLogos.items.map((it) => ({ url: it.url, x: it.x })),
    };
    if (brand.schoolName?.trim()) brandPayload.schoolName = brand.schoolName.trim();
    if (brand.schoolLogoUrl) brandPayload.schoolLogoUrl = brand.schoolLogoUrl;
    if (brand.tmcBrandKitId?.trim()) brandPayload.tmcBrandKitId = brand.tmcBrandKitId.trim();
    if (brand.coBrandingWording?.trim()) brandPayload.coBrandingWording = brand.coBrandingWording.trim();
    // Uploaded destination/student photos — backend sanitizeBrandKit validates
    // each URL and the renderer prefers these over stock photo search.
    if ((brand.imagePool || []).length) brandPayload.imagePool = brand.imagePool;
    // Exact logo position/size from the Logo placement & size preview — sent
    // whenever the corresponding logo exists, so the brochure always matches
    // what was shown in the preview rather than leaving it to chance.
    if (brand.logoUrl) brandPayload.tmcLogoPlacement = brand.tmcLogoPlacement || TMC_LOGO_DEFAULT;
    if (brand.schoolLogoUrl) brandPayload.schoolLogoPlacement = brand.schoolLogoPlacement || SCHOOL_LOGO_DEFAULT;

    const modelPayload = {};
    if (reasoningModel) modelPayload.models = { reasoning: reasoningModel };

    try {
      const body = {
        sectorKey: DEFAULT_SECTOR,
        styleKey: DEFAULT_STYLE,
        tripInput: mergedTripInput,
        ...(Object.keys(brandPayload).length ? { brand: brandPayload } : {}),
        ...modelPayload,
      };
      const res = await fetchApi('/api/travel/brochures/runs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const newRunId = res?.runId;
      const newBrochureId = res?.brochureId;
      if (!newRunId) throw new Error('No runId returned by the server.');
      setActiveRunId(newRunId);
      setActiveBrochureId(newBrochureId);
      activeBrochureIdRef.current = newBrochureId || null;
      openStream(newRunId);
      loadHistory();
    } catch (err) {
      setRunning(false);
      setRunError(err?.message || String(err));
      notify.error('Failed to start brochure run.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, tripInput, brand, reasoningModel, notify, loadHistory, askConfirm, goToStep]);

  const handleStop = useCallback(async () => {
    const runId = activeRunId;
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
    setRunning(false);
    setRunError(null);
    if (runId) {
      try {
        await fetchApi(`/api/travel/brochures/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        notify.info('Generation stopped.');
      } catch {
        notify.info('Generation stopped (the engine may finish in the background).');
      }
      loadHistory();
    }
  }, [activeRunId, notify, loadHistory]);

  const backfillPdfUrl = useCallback(async (brochureId, attempt = 0) => {
    if (!brochureId) return;
    try {
      const detail = await fetchApi(`/api/travel/brochures/${brochureId}`);
      const url = detail?.pdfUrl || detail?.brochure?.pdfUrl || null;
      const billed = detail?.billedUsd ?? detail?.brochure?.billedUsd;
      if (url || billed != null) {
        setResult((prev) => ({
          ...(prev || { result: null }),
          ...(url ? { pdfUrl: url } : {}),
          ...(billed != null ? { billedUsd: Number(billed) } : {}),
        }));
      }
      if (url) return;
      if (attempt < 3) setTimeout(() => backfillPdfUrl(brochureId, attempt + 1), 1500);
    } catch (e) {
      console.warn('[brochures] backfill pdfUrl failed', e);
    }
  }, []);

  const openStream = useCallback((runId) => {
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
    const token = getAuthToken();
    const url = `/api/travel/brochures/runs/${encodeURIComponent(runId)}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try {
      const es = new EventSource(url);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          setTraceEvents((prev) => [...prev, event]);
          if (event.type === 'run.completed') {
            const sseUrl = event.data?.pdfUrl || null;
            setResult({ pdfUrl: sseUrl, billedUsd: event.data?.billedUsd || 0, result: event.data?.result || null });
            setRunning(false);
            try { es.close(); } catch { /* ignore */ }
            esRef.current = null;
            loadHistory();
            if (activeBrochureIdRef.current) backfillPdfUrl(activeBrochureIdRef.current);
          } else if (event.type === 'run.failed') {
            setRunError(event.data?.error || 'Run failed');
            setRunning(false);
            try { es.close(); } catch { /* ignore */ }
            esRef.current = null;
            loadHistory();
          }
        } catch (parseErr) {
          console.warn('[brochures] bad SSE event', parseErr);
        }
      };
      es.onerror = () => {
        if (!running) {
          try { es.close(); } catch { /* ignore */ }
          esRef.current = null;
          pollOnce(runId);
        }
      };
    } catch (e) {
      console.warn('[brochures] SSE failed, falling back to polling', e);
      pollOnce(runId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, loadHistory, backfillPdfUrl]);

  const pollOnce = useCallback(async (runId) => {
    try {
      const snap = await fetchApi(`/api/travel/brochures/runs/${encodeURIComponent(runId)}`);
      if (snap.status === 'completed') {
        setResult({ pdfUrl: snap.pdfUrl || null, billedUsd: snap.billedUsd, result: null });
        setRunning(false);
        loadHistory();
        if (activeBrochureIdRef.current) backfillPdfUrl(activeBrochureIdRef.current);
      } else if (snap.status === 'failed') {
        setRunError(snap.errorMessage || 'Run failed');
        setRunning(false);
        loadHistory();
      } else {
        setTimeout(() => pollOnce(runId), 3000);
      }
    } catch (e) {
      console.warn('[brochures] poll failed', e);
    }
  }, [loadHistory, backfillPdfUrl]);

  useEffect(() => () => {
    if (esRef.current) { try { esRef.current.close(); } catch { /* ignore */ } esRef.current = null; }
  }, []);

  useEffect(() => {
    if (!result?.pdfUrl) { setPdfBlobUrl(null); return; }
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      try {
        const isAbsolute = /^https?:\/\//i.test(result.pdfUrl);
        const resp = await fetch(result.pdfUrl, {
          mode: isAbsolute ? 'cors' : 'same-origin',
          credentials: isAbsolute ? 'omit' : 'same-origin',
        });
        if (!resp.ok) throw new Error(`pdf fetch ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(objectUrl);
      } catch (e) {
        console.warn('[brochures] inline preview fetch failed; use Open/Download', e);
        if (!cancelled) setPdfBlobUrl(null);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [result?.pdfUrl]);

  const handleArchive = useCallback(async (row) => {
    if (!(await askConfirm(`Archive this brochure?\n\n${(row.goal || '').slice(0, 120)}…`, { confirmLabel: 'Archive', danger: true }))) return;
    try {
      await fetchApi(`/api/travel/brochures/${row.id}`, { method: 'DELETE' });
      notify.success('Brochure archived.');
      loadHistory();
    } catch {
      notify.error('Failed to archive brochure.');
    }
  }, [notify, loadHistory, askConfirm]);

  const brochureProxyUrl = (brochureId, { inline = false } = {}) => {
    if (!brochureId) return '';
    const qs = inline ? '?inline=1' : '';
    return `/api/travel/brochures/${encodeURIComponent(brochureId)}/download${qs}`;
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const currentStep = STEPS.find((s) => s.id === step) || STEPS[0];
  const StepIcon = currentStep.icon;

  return (
    <FormTouchedContext.Provider value={touched}>
    <div style={{ padding: 24, width: '100%', maxWidth: 1480, margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={pageHeaderRow}>
        <div>
          <h1 style={pageTitle}><Sparkles size={28} aria-hidden /> Brochure Engine</h1>
          <p style={pageSubtitle}>
            Create TMC school-trip brochures. Import from an itinerary or fill the simple steps below.
          </p>
        </div>
        <div style={tabBar}>
          <button type="button" onClick={() => setTab('generate')} style={tab === 'generate' ? activeTabBtn : tabBtn} data-testid="tab-generate">
            <Wand2 size={14} /> Generate
          </button>
          <button type="button" onClick={() => setTab('history')} style={tab === 'history' ? activeTabBtn : tabBtn} data-testid="tab-history">
            <HistoryIcon size={14} /> History {history.length > 0 ? `(${history.length})` : ''}
          </button>
        </div>
      </div>

      {aiError && (
        <div style={{ ...warningBanner, marginBottom: 16 }} data-testid="ai-provider-error">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>AI provider not ready</strong>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>
              {aiError.error} Configure an AI provider in{' '}
              <a href="/settings" style={{ color: 'inherit', textDecoration: 'underline' }}>Settings → AI</a>{' '}
              to generate brochures.
            </p>
          </div>
        </div>
      )}

      {tab === 'generate' && (
        <>
          {restoredDraft && !draftBannerDismissed && (
            <div style={{ ...warningBanner, marginBottom: 16, background: 'var(--subtle-bg)', borderColor: 'var(--border-color)' }}>
              <CheckCircle2 size={16} />
              <div style={{ flex: 1, fontSize: 13 }}>Restored your unsaved draft from earlier.</div>
              <button type="button" onClick={() => setDraftBannerDismissed(true)} style={{ ...secondaryBtn, flex: '0 0 auto' }}>Keep it</button>
              <button type="button" onClick={startFresh} style={{ ...secondaryBtn, flex: '0 0 auto' }}>Start fresh instead</button>
            </div>
          )}
          <ItineraryImport
            itineraries={itineraries}
            selectedId={selectedItineraryId}
            onSelect={setSelectedItineraryId}
            onImport={importFromItinerary}
            importing={importing}
            imported={imported}
            disabled={running}
          />

          {/* Progress bar */}
          <div id="brochure-step-progress" style={progressBar}>
            {STEPS.map((s) => {
              const Icon = s.icon;
              const active = s.id === step;
              const done = s.id < step;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goToStep(s.id)}
                  style={{
                    ...progressStep,
                    background: active ? 'var(--primary-color, var(--accent-color))' : done ? 'var(--subtle-bg-3)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary)',
                  }}
                  disabled={running}
                  data-testid={`step-${s.id}`}
                >
                  <Icon size={14} />
                  <span style={{ marginLeft: 6 }}>{s.label}</span>
                </button>
              );
            })}
          </div>

          {/* noValidate: type="email"/"url" fields still get the browser's own
              native format-mismatch popup on submit even without `required`
              on the DOM element (we deliberately never spread `required` onto
              inputs — see TextInput). That popup would silently fight our own
              validation UX (mild outlines, banner, jump-to-step) instead of
              cooperating with it. */}
          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: step === 1 ? 'block' : 'none' }}>
              <StepCard title="Brand & School" subtitle="School identity and TMC brand kit" icon={StepIcon}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px' }}>
                  <TextInput
                    label="School name" tip="The school or client name — printed on the cover and in the co-branding line (&quot;Exclusively designed for [School Name]...&quot;)."
                    required
                    value={brand.schoolName}
                    onChange={(v) => setBrand((b) => ({ ...b, schoolName: v }))}
                    placeholder="Delhi Public School"
                    data-testid="input-schoolName"
                  />
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="TMC Brand Kit" tip="Pick a saved brand kit to auto-fill agency identity." required />
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select
                        value={brand.tmcBrandKitId || ''}
                        onChange={(e) => { const id = e.target.value; if (id) loadBrandKitIdentity(id); else clearBrandKitIdentity(); }}
                        style={{ ...selectStyle, flex: 1 }}
                        disabled={running}
                        data-testid="brand-kit-select"
                      >
                        <option value="">— none —</option>
                        {brandKits.map((k) => (
                          <option key={k.id} value={String(k.id)}>
                            {String(k.id)}{k.subBrand ? ` · ${k.subBrand}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px' }}>
                  <TextInput
                    label="Agency name" tip="Defaults to &quot;The Modern Classroom&quot; — shown alongside the school on the cover."
                    value={brand.name}
                    onChange={(v) => setBrand((b) => ({ ...b, name: v }))}
                    placeholder="The Modern Classroom"
                  />
                  <TextInput
                    label="Tagline" tip="Printed exactly as supplied — defaults to &quot;TRAVEL. EXPERIENCE. LEARN.&quot;"
                    value={brand.tagline}
                    onChange={(v) => setBrand((b) => ({ ...b, tagline: v }))}
                    placeholder="TRAVEL. EXPERIENCE. LEARN."
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px' }}>
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="School logo" tip="PNG with transparency preferred. 800–1600 px ideal." required />
                    </label>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => { onUploadImages(e.target.files, 'school'); e.target.value = ''; }}
                      style={{ flex: 1 }}
                      disabled={running}
                      data-testid="school-logo-input"
                    />
                    {brand.schoolLogoUrl && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                        <img src={brand.schoolLogoUrl} alt="School logo preview" style={{ maxHeight: 48, maxWidth: 120, objectFit: 'contain', border: '1px solid var(--border-color)', borderRadius: 6, padding: 4, background: '#fff' }} />
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{brand.schoolLogoFileName}</span>
                        <button type="button" onClick={() => removeImage(brand.schoolLogoUrl)} style={iconBtn} aria-label="Remove school logo" title="Remove" disabled={running}><X size={14} /></button>
                      </div>
                    )}
                    {brand.schoolLogoUrl && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                        <input type="checkbox" checked={brand.schoolLogoApproved} onChange={(e) => setBrand((b) => ({ ...b, schoolLogoApproved: e.target.checked }))} disabled={running} data-testid="school-logo-approved" />
                        <span>School logo is approved for print</span>
                      </label>
                    )}
                  </div>
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="Agency / TMC logo" tip="Primary agency logo for cover and footer." />
                    </label>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => { onUploadImages(e.target.files, 'agency'); e.target.value = ''; }}
                      style={{ flex: 1 }}
                      disabled={running}
                      data-testid="agency-logo-input"
                    />
                    {brand.logoUrl && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                        <img src={brand.logoUrl} alt="Agency logo preview" style={{ maxHeight: 48, maxWidth: 120, objectFit: 'contain', border: '1px solid var(--border-color)', borderRadius: 6, padding: 4, background: '#fff' }} />
                        <button type="button" onClick={() => removeImage(brand.logoUrl)} style={iconBtn} aria-label="Remove agency logo" title="Remove" disabled={running}><X size={14} /></button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input
                    type="text"
                    value={brand.tmcBrandKitId}
                    onChange={(e) => setBrand((b) => ({ ...b, tmcBrandKitId: e.target.value }))}
                    placeholder="TMC brand kit ID"
                    style={{ ...inputStyle, flex: 1 }}
                    disabled={running}
                    data-testid="tmc-brand-kit-id"
                  />
                  {brandKits.some((k) => String(k.id) === String(brand.tmcBrandKitId)) && (
                    <span style={{ fontSize: 11, color: 'var(--primary-color, var(--accent-color))', whiteSpace: 'nowrap' }}>✓ loaded from kit</span>
                  )}
                </div>

                {(brand.logoUrl || brand.schoolLogoUrl) && (
                  <LogoPlacementEditor
                    brand={brand}
                    setBrand={setBrand}
                    heroPreviewUrl={brand.imagePool?.[0] || ''}
                    tripTitle={tripInput.tripTitle}
                  />
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px', marginTop: 16 }}>
                  <Select
                    label="Preferred school logo version"
                    tip="Which version of the school logo to feature, if the school supplied more than one."
                    value={brand.schoolLogoVersion}
                    onChange={(v) => setBrand((b) => ({ ...b, schoolLogoVersion: v }))}
                    options={[{ value: 'full-colour', label: 'Full colour' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
                  />
                  <TextInput
                    label="Approved co-branding wording"
                    tip='Printed on the cover. Defaults to the standard TMC line with the school name filled in.'
                    value={brand.coBrandingWording}
                    onChange={(v) => setBrand((b) => ({ ...b, coBrandingWording: v }))}
                    placeholder={`Exclusively designed for ${brand.schoolName || '[School Name]'} by The Modern Classroom`}
                  />
                </div>
                <BrochureAccentPicker
                  accent={brand.accent}
                  accentSecondary={brand.accentSecondary}
                  onAccentChange={(hex) => setBrand((b) => ({ ...b, accent: hex }))}
                  onAccentSecondaryChange={(hex) => setBrand((b) => ({ ...b, accentSecondary: hex }))}
                  kitColorChoices={brandKitColorChoices}
                />
                <div style={{ marginBottom: 16 }}>
                  <label style={fieldLabel}>
                    <LabelWithInfo label="Other approved partner logos" tip="Any additional partner logos approved for this brochure, beyond TMC and the school." />
                  </label>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(e) => { if (e.target.files?.length) onUploadImages(e.target.files, 'partner'); e.target.value = ''; }}
                    disabled={running}
                  />
                  {(brand.partnerLogos || []).length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {brand.partnerLogos.map((url) => (
                        <div key={url} style={{ position: 'relative' }}>
                          <img src={url} alt="Partner logo" style={{ maxHeight: 48, maxWidth: 100, objectFit: 'contain', border: '1px solid var(--border-color)', borderRadius: 6, padding: 4, background: '#fff' }} />
                          <button type="button" onClick={() => setBrand((b) => ({ ...b, partnerLogos: (b.partnerLogos || []).filter((u) => u !== url) }))} style={{ ...iconBtn, position: 'absolute', top: -6, right: -6, background: 'var(--surface-color)', border: '1px solid var(--border-color)' }} aria-label="Remove partner logo" disabled={running}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <TextArea
                  label="Special logo instructions"
                  tip="Anything unusual about how the logos should be handled — e.g. a specific safe zone, a required light background, an approval condition."
                  value={brand.specialLogoInstructions}
                  onChange={(v) => setBrand((b) => ({ ...b, specialLogoInstructions: v }))}
                  rows={2}
                  placeholder="Any special instructions for logo placement or treatment."
                />
              </StepCard>
            </div>

            <div style={{ display: step === 2 ? 'block' : 'none' }}>
              <StepCard title="Trip Details" subtitle="Title, destination, dates and learning goals" icon={StepIcon}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Trip title" tip="The main headline on the cover page, e.g. &quot;Japan STEM Tour 2026&quot;." required value={tripInput.tripTitle} onChange={(v) => updateTrip('tripTitle', v)} placeholder="Japan STEM Tour 2026" data-testid="input-tripTitle" />
                  <PlaceInput label="Destination" required tip="City, region or country — e.g. Manali, Japan, Dubai. Search to find and confirm the exact place." value={tripInput.destinationCountry} onChange={(v) => updateTrip('destinationCountry', v)} placeholder="Search a destination…" dataTestId="input-destinationCountry" error={validationErrors.find((e) => e.path === 'destinationCountry')?.msg} touched={touched} />
                  <TextInput label="Start date" tip="First day of travel. Duration below is calculated automatically from Start/End date." required type="date" value={tripInput.travelDates.from} onChange={(v) => updateTravelDate('from', v)} data-testid="input-travelDates-from" />
                  <TextInput label="End date" tip="Last day of travel. Duration below is calculated automatically from Start/End date." required type="date" value={tripInput.travelDates.to} onChange={(v) => updateTravelDate('to', v)} data-testid="input-travelDates-to" />
                  <TextInput label="Duration (days)" tip="Auto-calculated from Start/End date. Editing this directly only relabels the trip — change the dates above to actually change its length." required type="number" value={tripInput.durationDays} onChange={(v) => updateTrip('durationDays', v)} data-testid="input-durationDays" />
                  <TextInput label="Duration (nights)" tip="Auto-calculated from Start/End date." required type="number" value={tripInput.durationNights} onChange={(v) => updateTrip('durationNights', v)} data-testid="input-durationNights" />
                  <TextInput label="Target grades" tip="Grades or ages this trip is designed for, e.g. &quot;Grades 9–12&quot;." required value={tripInput.targetGrades} onChange={(v) => updateTrip('targetGrades', v)} placeholder="Grades 9–12" data-testid="input-targetGrades" />
                  <TextInput label="Expected students" tip="Approximate number of students travelling — used for group planning, not pricing." type="number" value={tripInput.expectedStudents} onChange={(v) => updateTrip('expectedStudents', v)} placeholder="40" data-testid="input-expectedStudents" />
                </div>
                <TextArea
                  label="Trip summary" tip="A short summary (about 80 words) of the trip, shown on the Overview page."
                  required
                  value={tripInput.tripSummary}
                  onChange={(v) => updateTrip('tripSummary', v)}
                  placeholder="A concise overview of the trip."
                  rows={3}
                  data-testid="input-tripSummary"
                  aiDraft={
                    <AiDraftButton
                      label="AI draft"
                      context={`Write a 2-3 sentence trip summary for a school educational trip. Destination: ${tripInput.destinationCountry || 'not specified'}. Trip title: ${tripInput.tripTitle || 'not specified'}. Target grades: ${tripInput.targetGrades || 'not specified'}. Duration: ${tripInput.durationDays || 'not specified'} days. Focus on educational value, safety, and what students will experience.`}
                      onDraft={(text) => updateTrip('tripSummary', text)}
                      disabled={running}
                      dataTestId="ai-draft-summary"
                    />
                  }
                />
                <TextArea
                  label="Primary objective" tip="The main educational goal of this trip."
                  required
                  value={tripInput.primaryObjective}
                  onChange={(v) => updateTrip('primaryObjective', v)}
                  placeholder="Why this trip matters educationally."
                  rows={3}
                  data-testid="input-primaryObjective"
                  aiDraft={
                    <AiDraftButton
                      label="AI draft"
                      context={`Write a 2-3 sentence primary educational objective for a school trip. Destination: ${tripInput.destinationCountry || 'not specified'}. Trip title: ${tripInput.tripTitle || 'not specified'}. Target grades: ${tripInput.targetGrades || 'not specified'}. Explain the core learning purpose and what students should gain.`}
                      onDraft={(text) => updateTrip('primaryObjective', text)}
                      disabled={running}
                      dataTestId="ai-draft-objective"
                    />
                  }
                />
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="Learning outcomes" tip="At least 3." required />
                    </label>
                    <AiDraftButton
                      label="AI draft all"
                      maxWords={150}
                      context={`Generate 4-5 specific learning outcomes for a school trip. Destination: ${tripInput.destinationCountry || 'not specified'}. Trip title: ${tripInput.tripTitle || 'not specified'}. Target grades: ${tripInput.targetGrades || 'not specified'}. Primary objective: ${tripInput.primaryObjective || 'not specified'}. Each outcome should be ONE short plain sentence (no markdown, no numbering prefix). Return ONLY a JSON array of strings, e.g. ["outcome 1", "outcome 2"].`}
                      onDraft={(text) => {
                        try {
                          const parsed = JSON.parse(text);
                          if (Array.isArray(parsed)) {
                            const outcomes = parsed.slice(0, 6).filter((x) => typeof x === 'string' && x.trim());
                            if (outcomes.length >= 3) {
                              setTripInput((prev) => ({ ...prev, learningOutcomes: outcomes }));
                            }
                          }
                        } catch {
                          updateTrip('learningOutcomes', text.split('\n').filter((x) => x.trim()).slice(0, 6));
                        }
                      }}
                      disabled={running}
                      dataTestId="ai-draft-outcomes"
                    />
                  </div>
                  {(tripInput.learningOutcomes || []).map((val, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <input
                        type="text"
                        value={val || ''}
                        onChange={(e) => updateArrayItem('learningOutcomes', i, e.target.value)}
                        style={{ ...inputStyle, flex: 1, borderColor: !String(val || '').trim() || (validationErrors.find((e) => e.path === 'learningOutcomes') && touched) ? '#e06a5a' : 'var(--border-color)' }}
                        data-testid={`input-learningOutcomes-${i}`}
                      />
                      <button type="button" onClick={() => removeArrayItem('learningOutcomes', i)} style={iconBtn} aria-label="Remove"><X size={14} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('learningOutcomes')} style={chipBtn}>+ Add outcome</button>
                  {validationErrors.find((e) => e.path === 'learningOutcomes') && touched && <span style={{ color: '#e06a5a', fontSize: 12, marginTop: 4, display: 'block' }}>{validationErrors.find((e) => e.path === 'learningOutcomes')?.msg}</span>}
                </div>
                <LocationTagInput
                  label="Route cities (in travel order)"
                  required
                  tip="Every city visited, added in the exact order the group travels through them. Press Enter or click a suggestion."
                  value={tripInput.routeCities}
                  onChange={(v) => updateTrip('routeCities', v)}
                  placeholder="e.g. Manali → Shimla → Delhi"
                  error={validationErrors.find((e) => e.path === 'routeCities')?.msg}
                  touched={touched}
                  dataTestId="input-routeCities"
                />
                <OvernightCitiesInput
                  label="Overnight cities"
                  required
                  tip="Cities where the group sleeps, with the number of nights spent in each. Required — at least one city."
                  items={tripInput.overnightCities}
                  onAdd={(city) => addArrayItem('overnightCities', city)}
                  onRemove={(i) => removeArrayItem('overnightCities', i)}
                  onChange={(i, v) => updateArrayItem('overnightCities', i, v)}
                  error={validationErrors.find((e) => e.path === 'overnightCities')?.msg}
                  touched={touched}
                />
                {String(tripInput.routeCities || '').trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      const cities = String(tripInput.routeCities).split('→').map((s) => s.trim()).filter(Boolean);
                      const seen = new Set();
                      const unique = [];
                      cities.forEach((c) => {
                        if (!seen.has(c)) {
                          seen.add(c);
                          unique.push({ city: c, nights: 1 });
                        }
                      });
                      setTripInput((prev) => ({ ...prev, overnightCities: unique }));
                      notify.info(`Set ${unique.length} overnight cities from route.`);
                    }}
                    style={{ ...chipBtn, marginBottom: 16 }}
                  >
                    Use route cities as overnight cities (1 night each)
                  </button>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Educational subtitle" tip="Optional secondary line shown under the trip title on the cover." value={tripInput.educationalSubtitle} onChange={(v) => updateTrip('educationalSubtitle', v)} placeholder="Optional subtitle" />
                  <TextInput label="Min group size" tip="Smallest group size this trip can run with." type="number" value={tripInput.minGroupSize} onChange={(v) => updateTrip('minGroupSize', v)} placeholder="20" />
                  <TextInput label="Max group size" tip="Largest group size this trip can accommodate." type="number" value={tripInput.maxGroupSize} onChange={(v) => updateTrip('maxGroupSize', v)} placeholder="45" />
                  <TextInput label="Teachers" tip="Number of accompanying teachers." value={tripInput.teachers} onChange={(v) => updateTrip('teachers', v)} placeholder="4 teachers" />
                  <TextInput label="Tour managers" tip="Number of accompanying tour managers." value={tripInput.tourManagers} onChange={(v) => updateTrip('tourManagers', v)} placeholder="2 tour managers" />
                  <TextInput label="Student : adult ratio" tip="Supervision ratio, e.g. &quot;10:1&quot;." value={tripInput.studentAdultRatio} onChange={(v) => updateTrip('studentAdultRatio', v)} placeholder="10:1" />
                  <TextInput label="Departure batches" tip="Number of separate departure groups, if the trip runs in more than one wave." value={tripInput.departureBatches} onChange={(v) => updateTrip('departureBatches', v)} placeholder="2 batches" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <PlaceInput label="Departure airport" tip="Airport code or name where the group departs from." value={tripInput.departureAirport} onChange={(v) => updateTrip('departureAirport', v)} placeholder="Search an airport…" />
                  <PlaceInput label="Arrival airport" tip="Airport code or name where the group lands." value={tripInput.arrivalAirport} onChange={(v) => updateTrip('arrivalAirport', v)} placeholder="Search an airport…" />
                </div>
                <TagArrayInput
                  label="Day-visit locations"
                  tip="Places visited during the day without overnight stay."
                  items={tripInput.dayVisitLocations}
                  onAdd={(val) => setTripInput((prev) => ({ ...prev, dayVisitLocations: [...(prev.dayVisitLocations || []), val] }))}
                  onRemove={(i) => setTripInput((prev) => ({ ...prev, dayVisitLocations: (prev.dayVisitLocations || []).filter((_, idx) => idx !== i) }))}
                  withLocationSearch
                  placeholder="e.g. Hakone ropeway"
                />
                <SmartComboInput
                  label="Curriculum connection" tip="Which subjects or curriculum areas this trip connects to. Pick as many as apply, or type your own and press Enter to save it for next time."
                  fieldKey="curriculumConnection" multi
                  presets={['Geography', 'History', 'Environmental Science', 'Biology', 'Social Studies', 'Economics', 'Art', 'Marine Science']}
                  value={tripInput.curriculumConnection} onChange={(v) => updateTrip('curriculumConnection', v)} placeholder="e.g. Geography, History"
                />
                <SmartComboInput
                  label="Skills developed" tip="Skills students build on this trip. Pick as many as apply, or type your own and press Enter to save it for next time."
                  fieldKey="skillsDeveloped" multi
                  presets={['Teamwork', 'Independence', 'Leadership', 'Communication', 'Problem-solving', 'Cultural awareness', 'Resilience', 'Time management']}
                  value={tripInput.skillsDeveloped} onChange={(v) => updateTrip('skillsDeveloped', v)} placeholder="e.g. Teamwork, independence"
                />
                <TextArea label="Special school requirements" tip="Any special requirements the school has flagged for this trip." value={tripInput.specialSchoolRequirements} onChange={(v) => updateTrip('specialSchoolRequirements', v)} rows={2} placeholder="Any special requirements from the school." />
              </StepCard>
            </div>

            <div style={{ display: step === 3 ? 'block' : 'none' }}>
              <StepCard title="Day by Day" subtitle="Itinerary for each day" icon={StepIcon}>
                {Number(tripInput.durationDays) > 0 && (tripInput.days || []).length !== Number(tripInput.durationDays) && (
                  <div style={{ ...warningBanner, marginBottom: 12 }}>
                    <AlertTriangle size={16} />
                    <div style={{ flex: 1, fontSize: 13 }}>
                      Duration is set to {tripInput.durationDays} day(s), but there {tripInput.days.length === 1 ? 'is' : 'are'} {tripInput.days.length} day card{tripInput.days.length === 1 ? '' : 's'} below.
                    </div>
                    <button type="button" onClick={syncDaysToDuration} style={{ ...secondaryBtn, flex: '0 0 auto' }}>
                      Match days to duration
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 10, marginBottom: 12, background: 'var(--subtle-bg)', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Meals for every day:</span>
                  {['B', 'L', 'D'].map((m) => (
                    <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={bulkMeals.includes(m)}
                        onChange={() => setBulkMeals((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))}
                      />
                      {m === 'B' ? 'Breakfast' : m === 'L' ? 'Lunch' : 'Dinner'}
                    </label>
                  ))}
                  <button type="button" onClick={() => setMealsForAllDays(bulkMeals)} style={{ ...secondaryBtn, flex: '0 0 auto' }}>
                    Apply to all {tripInput.days?.length || 0} days
                  </button>
                </div>
                {(tripInput.days || []).map((day, i) => (
                  <DayCard
                    key={i}
                    day={day}
                    index={i}
                    updateDay={updateDay}
                    removeDay={removeDay}
                    toggleMeal={toggleMeal}
                    disabled={running}
                    canRemove={tripInput.days.length > 1}
                    cityOptions={dayCityOptions}
                    onCopyOvernightFromPrevious={i > 0 ? () => updateDay(i, 'overnightCity', tripInput.days[i - 1].overnightCity || '') : null}
                  />
                ))}
                <button type="button" onClick={addDay} style={{ ...secondaryBtn, width: '100%', justifyContent: 'center' }}>+ Add day</button>
              </StepCard>
            </div>

            <div style={{ display: step === 4 ? 'block' : 'none' }}>
              <StepCard title="Logistics & Pricing" subtitle="Flights, hotels, cost and payment terms" icon={StepIcon}>
                <h4 style={sectionTitle}>Flights & Transport</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <Select label="Flight status" tip="Whether flights are included in the price, excluded, proposed, or not applicable." value={tripInput.flights.status} onChange={(v) => updateTrip('flights.status', v)} options={['included', 'excluded', 'proposed', 'na'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
                  <TextInput label="Airline" tip="Airline operating the flights." value={tripInput.flights.airline} onChange={(v) => updateTrip('flights.airline', v)} />
                  <TextInput label="Flight numbers" tip="Flight numbers for the group's sectors." value={tripInput.flights.flightNumbers} onChange={(v) => updateTrip('flights.flightNumbers', v)} placeholder="AI-101 / AI-102" />
                  <TextInput label="Departure details" tip="Departure city, date and time." value={tripInput.flights.departure} onChange={(v) => updateTrip('flights.departure', v)} placeholder="Delhi, 08:30" />
                  <TextInput label="Arrival details" tip="Arrival city, date and time." value={tripInput.flights.arrival} onChange={(v) => updateTrip('flights.arrival', v)} placeholder="Tokyo, 19:45" />
                  <TextInput label="Baggage" tip="Baggage allowance included with the fare." value={tripInput.flights.baggage} onChange={(v) => updateTrip('flights.baggage', v)} placeholder="20 kg check-in" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Airport transfers" tip="Transport between airports and hotels." value={tripInput.airportTransfers} onChange={(v) => updateTrip('airportTransfers', v)} placeholder="Private coach" />
                  <TextInput label="Intercity transport" tip="Transport used to move between cities on the route." value={tripInput.intercityTransport} onChange={(v) => updateTrip('intercityTransport', v)} placeholder="Shinkansen" />
                  <TextInput label="Local transport" tip="Transport used for local sightseeing, e.g. metro or coach." value={tripInput.localTransport} onChange={(v) => updateTrip('localTransport', v)} placeholder="Metro / coach" />
                  <TextInput label="Rail journeys" tip="Any train journeys included in the itinerary." value={tripInput.railJourneys} onChange={(v) => updateTrip('railJourneys', v)} placeholder="Bullet train" />
                  <TextInput label="Long travel sectors" tip="Any especially long travel legs worth flagging to parents." value={tripInput.longTravelSectors} onChange={(v) => updateTrip('longTravelSectors', v)} placeholder="Delhi-Tokyo flight" />
                </div>

                <h4 style={sectionTitle}>Hotels & Meals</h4>
                <div style={{ marginBottom: 16 }}>
                  <label style={fieldLabel}>
                    <LabelWithInfo label="Hotels" tip="Confirmed or proposed accommodation for each city on the route." />
                  </label>
                  {(tripInput.hotels || []).map((h, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 80px auto', gap: 8, marginBottom: 8 }}>
                      <input type="text" value={h.name || ''} onChange={(e) => updateArrayItem('hotels', i, { ...h, name: e.target.value })} placeholder="Hotel name" style={inputStyle} />
                      <InlinePlaceInput value={h.city || ''} onChange={(v) => updateArrayItem('hotels', i, { ...h, city: v })} placeholder="City" quickPicks={dayCityOptions} />
                      <input type="text" value={h.category || ''} onChange={(e) => updateArrayItem('hotels', i, { ...h, category: e.target.value })} placeholder="Category" style={inputStyle} />
                      <input type="number" value={h.nights || ''} onChange={(e) => updateArrayItem('hotels', i, { ...h, nights: Number(e.target.value) })} placeholder="Nights" style={inputStyle} />
                      <button type="button" onClick={() => removeArrayItem('hotels', i)} style={iconBtn}><X size={14} /></button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => addArrayItem('hotels', { name: '', city: primaryDestinationCity, category: '', nights: '' })}
                      style={chipBtn}
                    >
                      + Add hotel
                    </button>
                    {primaryDestinationCity && (tripInput.hotels || []).length > 1 && (
                      <button
                        type="button"
                        onClick={() => setTripInput((prev) => ({ ...prev, hotels: (prev.hotels || []).map((h) => ({ ...h, city: primaryDestinationCity })) }))}
                        style={secondaryBtn}
                      >
                        Fill all cities with &quot;{primaryDestinationCity}&quot;
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <SmartComboInput
                    label="Room sharing basis" tip="How students are roomed. Pick from the list, or type your own and press Enter to save it for next time."
                    fieldKey="roomSharingBasis"
                    presets={['Twin sharing', 'Triple sharing', 'Quad sharing', 'Same-gender rooming']}
                    value={tripInput.roomSharingBasis} onChange={(v) => updateTrip('roomSharingBasis', v)} placeholder="Twin / triple"
                  />
                  <SmartComboInput
                    label="Teacher room arrangement" tip="Room arrangement for accompanying teachers. Pick from the list, or type your own and press Enter to save it for next time."
                    fieldKey="teacherRoomArrangement"
                    presets={['Separate single rooms', 'Twin sharing with another teacher', 'One teacher per floor']}
                    value={tripInput.teacherRoomArrangement} onChange={(v) => updateTrip('teacherRoomArrangement', v)} placeholder="Separate single rooms"
                  />
                  <DerivedMealCount label="Breakfasts" tip="Counted automatically from the Breakfast checkboxes on the day-by-day itinerary — tick them there, not here." count={derivedMealCounts.B} noun="breakfast" />
                  <DerivedMealCount label="Lunches" tip="Counted automatically from the Lunch checkboxes on the day-by-day itinerary — tick them there, not here." count={derivedMealCounts.L} noun="lunch" plural="lunches" />
                  <DerivedMealCount label="Dinners" tip="Counted automatically from the Dinner checkboxes on the day-by-day itinerary — tick them there, not here." count={derivedMealCounts.D} noun="dinner" />
                  <SmartComboInput
                    label="Special meals" tip="Any special meal occasions. Pick from the list, or type your own and press Enter to save it for next time."
                    fieldKey="specialMeals" multi
                    presets={['Welcome dinner', 'Farewell dinner', 'Birthday cake on request']}
                    value={tripInput.specialMeals} onChange={(v) => updateTrip('specialMeals', v)} placeholder="Welcome dinner"
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <SmartComboInput
                    label="Dietary support" tip="Dietary accommodations offered. Pick as many as apply, or type your own and press Enter to save it for next time."
                    fieldKey="dietarySupport" multi
                    presets={['Vegetarian', 'Vegan', 'Halal', 'Jain', 'Allergy-aware', 'Gluten-free', 'Kosher']}
                    value={tripInput.dietarySupport} onChange={(v) => updateTrip('dietarySupport', v)} placeholder="Vegetarian / halal / allergy"
                  />
                  <TextInput label="Meals excluded" tip="Meals or food costs not included in the price." value={tripInput.mealsExcluded} onChange={(v) => updateTrip('mealsExcluded', v)} placeholder="Snacks, drinks" />
                </div>

                <h4 style={sectionTitle}>Pricing & Payment</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <SmartComboInput
                    label="Currency" tip="3-letter currency code the price is quoted in. Pick from the list, or type your own and press Enter to save it for next time."
                    fieldKey="currency" required
                    presets={['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD']}
                    value={tripInput.currency} onChange={(v) => updateTrip('currency', v)} placeholder="INR"
                    dataTestId="input-currency"
                  />
                  <TextInput label="Price per person" tip="The headline price shown on the Investment & Action page." required type="number" value={tripInput.pricePerPerson} onChange={(v) => updateTrip('pricePerPerson', v)} data-testid="input-pricePerPerson" />
                  <SmartComboInput
                    label="Occupancy basis" tip="The room-sharing basis the price is calculated on. Pick from the list, or type your own and press Enter to save it for next time."
                    fieldKey="occupancyBasis" required
                    presets={['Twin sharing', 'Triple sharing', 'Quad sharing', 'Single occupancy', 'Double sharing']}
                    value={tripInput.occupancyBasis} onChange={(v) => updateTrip('occupancyBasis', v)} placeholder="Twin sharing"
                    dataTestId="input-occupancyBasis"
                  />
                  <TextInput label="Single supplement" tip="Extra cost for a single (non-shared) room, if applicable." type="number" value={tripInput.singleSupplement} onChange={(v) => updateTrip('singleSupplement', v)} />
                  <TextInput label="Student price" tip="Price specific to students, if different from the standard per-person price." type="number" value={tripInput.studentPrice} onChange={(v) => updateTrip('studentPrice', v)} />
                  <TextInput label="Teacher price" tip="Price specific to accompanying teachers, if different." type="number" value={tripInput.teacherPrice} onChange={(v) => updateTrip('teacherPrice', v)} />
                  <TextInput label="Minimum paying group" tip="Minimum number of paying travellers needed to run this trip at this price." value={tripInput.minPayingGroup} onChange={(v) => updateTrip('minPayingGroup', v)} placeholder="30" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Deposit amount" tip="Upfront amount due to secure a booking." required type="number" value={tripInput.deposit.amount} onChange={(v) => updateTrip('deposit.amount', v)} data-testid="input-deposit-amount" />
                  <TextInput label="Deposit due date" tip="Date the deposit must be paid by." required type="date" value={tripInput.deposit.dueDate} onChange={(v) => updateTrip('deposit.dueDate', v)} data-testid="input-deposit-dueDate" />
                  <TextInput label="Final payment date" tip="Date the full balance is due." type="date" value={tripInput.finalPaymentDate} onChange={(v) => updateTrip('finalPaymentDate', v)} />
                  <TextInput label="Booking deadline" tip="Last date a family can book this trip." type="date" value={tripInput.bookingDeadline} onChange={(v) => updateTrip('bookingDeadline', v)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Taxes included" tip="Taxes already built into the quoted price, e.g. &quot;GST 5%&quot;." value={tripInput.taxesIncluded} onChange={(v) => updateTrip('taxesIncluded', v)} placeholder="GST 5%" />
                  <TextInput label="Taxes excluded" tip="Taxes charged separately, on top of the quoted price." value={tripInput.taxesExcluded} onChange={(v) => updateTrip('taxesExcluded', v)} placeholder="TCS 5%" />
                  <TextInput label="Price validity" tip="How long this price is guaranteed for." value={tripInput.priceValidity} onChange={(v) => updateTrip('priceValidity', v)} placeholder="Valid till 31 Jan 2026" />
                </div>
                <TextArea label="Cancellation terms" tip="The approved cancellation and refund wording — printed exactly as supplied, never invented." value={tripInput.cancellationTerms} onChange={(v) => updateTrip('cancellationTerms', v)} rows={2} placeholder="Approved cancellation and refund terms." />

                <h4 style={sectionTitle}>Optional Online Payment</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Payment link" tip="Approved HTTPS payment link. Copied exactly — never shortened or altered." type="url" value={tripInput.paymentLink} onChange={(v) => updateTrip('paymentLink', v)} placeholder="https://pay.example.com/…" />
                  <TextInput label="Payment-button label" tip="Text shown on the payment button, defaults to &quot;Make payment&quot;." value={tripInput.paymentButtonLabel} onChange={(v) => updateTrip('paymentButtonLabel', v)} placeholder="Make payment" />
                  <TextInput label="Link expiry date" tip="Date after which the payment link should no longer be used." type="date" value={tripInput.paymentLinkExpiry} onChange={(v) => updateTrip('paymentLinkExpiry', v)} />
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={tripInput.paymentQr} onChange={(e) => updateTrip('paymentQr', e.target.checked)} />
                    Create payment QR
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={tripInput.paymentLinkApproved} onChange={(e) => updateTrip('paymentLinkApproved', e.target.checked)} />
                    Link approved by finance team
                  </label>
                </div>
                <TextArea label="Payment instructions" tip="Any instructions to print next to the payment link or QR code." value={tripInput.paymentInstructions} onChange={(v) => updateTrip('paymentInstructions', v)} rows={2} placeholder="Instructions to print beside the payment link." />

                <h4 style={sectionTitle}>Theme & Inclusions</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="Theme mode" required />
                    </label>
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 2 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="themeMode" checked={tripInput.themeMode === 'auto'} onChange={() => updateTrip('themeMode', 'auto')} />
                        Auto
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="themeMode" checked={tripInput.themeMode === 'manual'} onChange={() => updateTrip('themeMode', 'manual')} />
                        Manual
                      </label>
                    </div>
                  </div>
                  <TextInput label="Travel season" tip="The season of travel — informs the auto-generated destination colour theme." required value={tripInput.travelSeason} onChange={(v) => updateTrip('travelSeason', v)} placeholder="Summer 2026" data-testid="input-travelSeason" />
                </div>
                {tripInput.themeMode === 'manual' && (
                  <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)' }}>
                    <label style={{ ...fieldLabel, marginBottom: 8 }}>
                      <LabelWithInfo
                        label="Manual page tone"
                        tip="Sets the page background and body-text colour. The accent colour (and optional gradient second colour) is set separately in Brand & School → Brochure colour accent — that field always controls the accent, whatever's picked here."
                      />
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0 12px' }}>
                      {['background', 'text'].map((c) => (
                        <div key={c} style={fieldLabel}>
                          <span style={{ textTransform: 'capitalize', fontSize: 12 }}>{c}</span>
                          <input type="color" value={tripInput.manualHexPalette[c] || '#ffffff'} onChange={(e) => updateTrip(`manualHexPalette.${c}`, e.target.value)} style={{ ...inputStyle, padding: 4, height: 40, width: '100%' }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="Preferred mood (optional)" tip="Leave blank and the AI derives a mood from the destination automatically. Quick-pick a common mood, or type your own below, only if you want to steer it." />
                    </label>
                    <select
                      value=""
                      onChange={(e) => { if (e.target.value) updateTrip('preferredMood', e.target.value); }}
                      style={selectStyle}
                    >
                      <option value="">AI decides automatically (recommended)</option>
                      {['Calm & Reassuring', 'Vibrant & Energetic', 'Adventurous & Bold', 'Elegant & Refined', 'Playful & Fun'].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <input type="text" value={tripInput.preferredMood} onChange={(e) => updateTrip('preferredMood', e.target.value)} placeholder="Leave blank for automatic" style={{ ...inputStyle, marginTop: 6 }} />
                  </div>
                  <Select
                    label="Theme approval"
                    tip="Whether to generate the destination theme automatically, or show the palette to approve first."
                    value={tripInput.themeApproval}
                    onChange={(v) => updateTrip('themeApproval', v)}
                    options={[{ value: 'generate', label: 'Generate automatically' }, { value: 'show-first', label: 'Show palette first' }]}
                  />
                </div>
                <div
                  data-testid="theme-colour-preferences"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
                    columnGap: 16,
                    rowGap: 12,
                    marginTop: 4,
                  }}
                >
                  <ToggleSection
                    label="Preferred colours"
                    tip="Off: the AI picks colours from the destination automatically. On: the first colour here becomes the brochure's accent."
                    enabled={usePreferredColours}
                    onToggle={(on) => { setUsePreferredColours(on); if (!on) updateTrip('preferredColours', ''); }}
                  >
                    <ColorTagInput
                      label=""
                      items={tripInput.preferredColours ? tripInput.preferredColours.split(',').map((s) => s.trim()).filter(Boolean) : []}
                      onAdd={(hex) => updateTrip('preferredColours', [...(tripInput.preferredColours ? tripInput.preferredColours.split(',').map((s) => s.trim()).filter(Boolean) : []), hex].join(', '))}
                      onRemove={(i) => updateTrip('preferredColours', (tripInput.preferredColours ? tripInput.preferredColours.split(',').map((s) => s.trim()).filter(Boolean) : []).filter((_, idx) => idx !== i).join(', '))}
                    />
                  </ToggleSection>
                  <ToggleSection
                    label="Colours to avoid"
                    tip="Off: no colour restrictions. On: these colours will never be used as the theme accent."
                    enabled={useColoursToAvoid}
                    onToggle={(on) => { setUseColoursToAvoid(on); if (!on) updateTrip('coloursToAvoid', ''); }}
                  >
                    <ColorTagInput
                      label=""
                      items={tripInput.coloursToAvoid ? tripInput.coloursToAvoid.split(',').map((s) => s.trim()).filter(Boolean) : []}
                      onAdd={(hex) => updateTrip('coloursToAvoid', [...(tripInput.coloursToAvoid ? tripInput.coloursToAvoid.split(',').map((s) => s.trim()).filter(Boolean) : []), hex].join(', '))}
                      onRemove={(i) => updateTrip('coloursToAvoid', (tripInput.coloursToAvoid ? tripInput.coloursToAvoid.split(',').map((s) => s.trim()).filter(Boolean) : []).filter((_, idx) => idx !== i).join(', '))}
                    />
                  </ToggleSection>
                </div>
                {conflictingColours.length > 0 && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 8, border: '1px solid #e0a95a', background: 'rgba(224, 169, 90, 0.12)', fontSize: 13, color: 'var(--text-primary)' }}>
                    <b>{conflictingColours.join(', ')}</b> {conflictingColours.length === 1 ? 'is' : 'are'} listed as both preferred and avoided — the avoid list wins, so {conflictingColours.length === 1 ? 'it' : 'they'} will not be used.
                  </div>
                )}
                <TextArea
                  label="Visual inspiration (optional)"
                  tip="Leave blank unless you have a specific reference in mind — the AI otherwise derives the visual direction from the destination itself."
                  value={tripInput.visualInspiration}
                  onChange={(v) => updateTrip('visualInspiration', v)}
                  rows={2}
                  placeholder="Optional — link to a mood board, or a short description"
                />
                <ArrayText
                  label="Inclusions" tip="Everything included in the price. Required — at least one item."
                  required
                  path="inclusions"
                  items={tripInput.inclusions}
                  onAdd={() => addArrayItem('inclusions')}
                  onRemove={(i) => removeArrayItem('inclusions', i)}
                  onChange={(i, v) => updateArrayItem('inclusions', i, v)}
                  error={validationErrors.find((e) => e.path === 'inclusions')?.msg}
                  touched={touched}
                  addLabel="Add inclusion"
                />
                <ArrayText
                  label="Exclusions" tip="Everything NOT included in the price. Required — at least one item. Never repeats an inclusion."
                  required
                  path="exclusions"
                  items={tripInput.exclusions}
                  onAdd={() => addArrayItem('exclusions')}
                  onRemove={(i) => removeArrayItem('exclusions', i)}
                  onChange={(i, v) => updateArrayItem('exclusions', i, v)}
                  error={validationErrors.find((e) => e.path === 'exclusions')?.msg}
                  touched={touched}
                  addLabel="Add exclusion"
                />

                <h4 style={sectionTitle}>Mandatory Cost Status</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 16px' }}>
                  <Select label="Return airfare" value={tripInput.costStatus.airfare} onChange={(v) => updateTrip('costStatus.airfare', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'na', label: 'N/A' }]} />
                  <Select label="GST" value={tripInput.costStatus.gst} onChange={(v) => updateTrip('costStatus.gst', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'na', label: 'N/A' }]} />
                  <Select label="TCS" value={tripInput.costStatus.tcs} onChange={(v) => updateTrip('costStatus.tcs', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'na', label: 'N/A' }]} />
                  <Select label="Travel insurance" value={tripInput.costStatus.travelInsurance} onChange={(v) => updateTrip('costStatus.travelInsurance', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'pending', label: 'Pending' }]} />
                  <Select label="Visa or permit" value={tripInput.costStatus.visaPermit} onChange={(v) => updateTrip('costStatus.visaPermit', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'na', label: 'N/A' }]} />
                  <Select label="Destination entry fee / SDF" value={tripInput.costStatus.destinationEntryFee} onChange={(v) => updateTrip('costStatus.destinationEntryFee', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'na', label: 'N/A' }]} />
                  <Select label="Entrance fees" value={tripInput.costStatus.entranceFees} onChange={(v) => updateTrip('costStatus.entranceFees', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'partly', label: 'Partly included' }]} />
                  <Select label="Tips" value={tripInput.costStatus.tips} onChange={(v) => updateTrip('costStatus.tips', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }]} />
                  <Select label="Personal expenses" value={tripInput.costStatus.personalExpenses} onChange={(v) => updateTrip('costStatus.personalExpenses', v)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }]} />
                </div>
                <TextInput label="Other compulsory charge not included" tip="Any other mandatory charge not covered by the statuses above." value={tripInput.costStatus.otherCompulsoryCharge} onChange={(v) => updateTrip('costStatus.otherCompulsoryCharge', v)} placeholder="e.g. Resort fee, city tax" />

                <h4 style={sectionTitle}>Safety and Documents</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px' }}>
                  <TextArea label="Passport and visa requirements" tip="What passport/visa documentation the trip requires." value={tripInput.passportVisa} onChange={(v) => updateTrip('passportVisa', v)} rows={2} placeholder="e.g. Passport valid 6+ months, visa on arrival" />
                  <TextArea label="Consent and medical forms" tip="What consent/medical forms parents or guardians must complete." value={tripInput.consentForms} onChange={(v) => updateTrip('consentForms', v)} rows={2} placeholder="e.g. Medical consent form, allergy declaration" />
                  <TextArea label="Insurance details" tip="Details of the travel insurance policy covering this trip." value={tripInput.insuranceDetails} onChange={(v) => updateTrip('insuranceDetails', v)} rows={2} placeholder="e.g. Policy provider and coverage summary" />
                  <TextArea label="Supervision and emergency support" tip="Staff-to-student supervision ratio and emergency contact arrangements." value={tripInput.supervisionEmergency} onChange={(v) => updateTrip('supervisionEmergency', v)} rows={2} placeholder="e.g. 24/7 tour manager, local emergency contact" />
                  <TextArea label="Accessibility needs" tip="Any accessibility accommodations arranged for this trip." value={tripInput.accessibilityNeeds} onChange={(v) => updateTrip('accessibilityNeeds', v)} rows={2} placeholder="e.g. Wheelchair-accessible transport" />
                  <div>
                    <label style={fieldLabel}>
                      <LabelWithInfo label="Passport custody" tip="Who holds student passports during the trip." />
                    </label>
                    <select value={tripInput.passportCustody} onChange={(e) => updateTrip('passportCustody', e.target.value)} style={selectStyle}>
                      <option value="">— not specified —</option>
                      <option value="Tour manager holds passports">Tour manager holds passports</option>
                      <option value="School holds passports">School holds passports</option>
                      <option value="Parents hold passports">Parents hold passports</option>
                      <option value="Not applicable">Not applicable</option>
                    </select>
                  </div>
                </div>
                <TextArea label="Curfew or conduct rules" tip="Curfew times or conduct expectations for students during the trip." value={tripInput.curfewRules} onChange={(v) => updateTrip('curfewRules', v)} rows={2} placeholder="e.g. In rooms by 22:00, no leaving hotel unsupervised" />
              </StepCard>
            </div>

            <div style={{ display: step === 5 ? 'block' : 'none' }}>
              <StepCard title="Contact & Generate" subtitle="Final details and review" icon={StepIcon}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="Primary phone" tip="Main contact phone number shown on the final page." required value={tripInput.primaryPhone} onChange={(v) => updateTrip('primaryPhone', v)} placeholder="+91 98765 43210" data-testid="input-primaryPhone" />
                  <TextInput label="Email" tip="Main contact email shown on the final page." required type="email" value={tripInput.email} onChange={(v) => updateTrip('email', v)} placeholder="hello@school.edu" data-testid="input-email" error={validationErrors.find((e) => e.path === 'email')?.msg} touched={touched} />
                  <TextInput label="Website" tip="School or trip website shown on the final page." required type="url" value={tripInput.website} onChange={(v) => updateTrip('website', v)} placeholder="https://school.edu" data-testid="input-website" error={validationErrors.find((e) => e.path === 'website')?.msg} touched={touched} />
                </div>
                <TextArea
                  label="Call to action" tip="The closing prompt on the final page, e.g. &quot;Book your seat today&quot;."
                  required
                  value={tripInput.callToAction}
                  onChange={(v) => updateTrip('callToAction', v)}
                  placeholder="Book by 31 January 2026. Limited seats."
                  rows={3}
                  data-testid="input-callToAction"
                  aiDraft={
                    <AiDraftButton
                      label="AI draft"
                      maxWords={25}
                      context={`Write a short, compelling call to action for a school trip brochure. Destination: ${tripInput.destinationCountry || 'not specified'}. Trip title: ${tripInput.tripTitle || 'not specified'}. Travel dates: ${tripInput.travelDates?.from || 'not specified'} to ${tripInput.travelDates?.to || 'not specified'}. Encourage parents and schools to book before the deadline. One or two sentences.`}
                      onDraft={(text) => updateTrip('callToAction', text)}
                      disabled={running}
                      dataTestId="ai-draft-cta"
                    />
                  }
                />

                <h4 style={sectionTitle}>Images</h4>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                  Upload your own destination/student photos here if you have specific ones the brochure must use. If you skip this, the engine automatically sources matching, licensed destination photography — uploading is optional, not required.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
                  <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
                      <input type="checkbox" checked={tripInput.destinationImagesUploaded} onChange={(e) => updateTrip('destinationImagesUploaded', e.target.checked)} />
                      Destination images uploaded
                    </label>
                    <label style={{ ...secondaryBtn, display: 'inline-flex', cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1 }}>
                      <Upload size={14} /> Upload destination photos
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        disabled={running}
                        style={{ display: 'none' }}
                        onChange={(e) => { if (e.target.files?.length) { onUploadImages(e.target.files, 'pool'); updateTrip('destinationImagesUploaded', true); } e.target.value = ''; }}
                      />
                    </label>
                  </div>
                  <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
                      <input type="checkbox" checked={tripInput.studentImagesUploaded} onChange={(e) => updateTrip('studentImagesUploaded', e.target.checked)} />
                      Student images uploaded
                    </label>
                    <label style={{ ...secondaryBtn, display: 'inline-flex', cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1 }}>
                      <Upload size={14} /> Upload student photos
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        disabled={running}
                        style={{ display: 'none' }}
                        onChange={(e) => { if (e.target.files?.length) { onUploadImages(e.target.files, 'pool'); updateTrip('studentImagesUploaded', true); } e.target.value = ''; }}
                      />
                    </label>
                  </div>
                </div>
                {(brand.imagePool || []).length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>{brand.imagePool.length} image{brand.imagePool.length === 1 ? '' : 's'} uploaded (shared pool — used across logos and photos):</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {brand.imagePool.map((url) => (
                        <div key={url} style={{ position: 'relative', width: 64, height: 64 }}>
                          <img src={url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-color)' }} />
                          <button type="button" onClick={() => removeImage(url)} style={{ ...iconBtn, position: 'absolute', top: -6, right: -6, background: 'var(--surface-color)', border: '1px solid var(--border-color)' }} aria-label="Remove image" disabled={running}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', marginBottom: 12 }}>
                  <input type="checkbox" checked={tripInput.imageConsentConfirmed} onChange={(e) => updateTrip('imageConsentConfirmed', e.target.checked)} />
                  Image consent confirmed
                </label>
                <TextArea label="Images or subjects to avoid" tip="Anything that must not appear in destination imagery." value={tripInput.imagesToAvoid} onChange={(v) => updateTrip('imagesToAvoid', v)} rows={2} placeholder="e.g. Crowds, political landmarks" />

                <h4 style={sectionTitle}>Map</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <Select label="Map style" tip="Visual style of the route map. Currently only the default 2D map is supported." value={tripInput.mapStyle} onChange={(v) => updateTrip('mapStyle', v)} options={[{ value: 'default-2d', label: 'Default 2D' }]} />
                </div>
                <TagArrayInput
                  label="Required markers"
                  tip="Places that must appear on the route map."
                  items={tripInput.requiredMarkers}
                  onAdd={(val) => setTripInput((prev) => ({ ...prev, requiredMarkers: [...(prev.requiredMarkers || []), val] }))}
                  onRemove={(i) => setTripInput((prev) => ({ ...prev, requiredMarkers: (prev.requiredMarkers || []).filter((_, idx) => idx !== i) }))}
                  withLocationSearch
                  placeholder="e.g. Tokyo Tower"
                />
                <TagArrayInput
                  label="Locations to exclude"
                  tip="Places that should not appear on the route map."
                  items={tripInput.locationsToExclude}
                  onAdd={(val) => setTripInput((prev) => ({ ...prev, locationsToExclude: [...(prev.locationsToExclude || []), val] }))}
                  onRemove={(i) => setTripInput((prev) => ({ ...prev, locationsToExclude: (prev.locationsToExclude || []).filter((_, idx) => idx !== i) }))}
                  withLocationSearch
                  placeholder="e.g. Airport"
                />

                <h4 style={sectionTitle}>Socials & QR</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }}>
                  <TextInput label="WhatsApp" tip="WhatsApp contact link or number." value={tripInput.whatsapp} onChange={(v) => updateTrip('whatsapp', v)} placeholder="+91 98765 43210" />
                  <TextInput label="YouTube" tip="YouTube channel link." value={tripInput.youtube} onChange={(v) => updateTrip('youtube', v)} placeholder="https://youtube.com/…" />
                  <TextInput label="Facebook" tip="Facebook page link." value={tripInput.facebook} onChange={(v) => updateTrip('facebook', v)} placeholder="https://facebook.com/…" />
                  <TextInput label="Instagram" tip="Instagram profile link." value={tripInput.instagram} onChange={(v) => updateTrip('instagram', v)} placeholder="https://instagram.com/…" />
                  <TextInput label="General QR URL" tip="URL encoded into the general QR code on the final page." type="url" value={tripInput.generalQrUrl} onChange={(v) => updateTrip('generalQrUrl', v)} placeholder="https://themodernclassroom.com" />
                </div>

                <h4 style={sectionTitle}>Source Control</h4>
                <div style={{ marginBottom: 16 }}>
                  <label style={fieldLabel}>
                    <LabelWithInfo label="Uploaded itinerary, costing, flight, hotel and terms files" tip="Kept as your own reference/audit trail. These files are not read by the AI — transcribe the real facts into the fields above." />
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(e) => { if (e.target.files?.length) onUploadReferenceFiles(e.target.files); e.target.value = ''; }}
                    disabled={running}
                  />
                  {(tripInput.uploadedFiles || []).length > 0 && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                      {tripInput.uploadedFiles.map((f, i) => (
                        <li key={`${f.url}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
                          <span style={{ color: 'var(--text-secondary)' }}>{f.size ? `(${Math.round(f.size / 1024)} KB)` : ''}</span>
                          <button type="button" onClick={() => setTripInput((prev) => ({ ...prev, uploadedFiles: prev.uploadedFiles.filter((_, idx) => idx !== i) }))} style={iconBtn} aria-label={`Remove ${f.name}`}>
                            <X size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <TextArea label="Facts awaiting confirmation" tip="Anything not yet confirmed — kept out of the printed brochure." value={tripInput.factsAwaitingConfirmation} onChange={(v) => updateTrip('factsAwaitingConfirmation', v)} rows={2} placeholder="Anything not yet confirmed." />
                <TextArea label="Known contradictions" tip="Any conflicting facts across your source documents that still need resolving." value={tripInput.knownContradictions} onChange={(v) => updateTrip('knownContradictions', v)} rows={2} placeholder="Contradictory facts that need checking." />
                <TextArea label="Do not print" tip="Internal notes that must never appear in the printed brochure." value={tripInput.doNotPrint} onChange={(v) => updateTrip('doNotPrint', v)} rows={2} placeholder="Internal notes that must not appear in the brochure." />
                <TextArea label="Previous trip references" tip="Any references to older or other trips that need to be removed." value={tripInput.previousTripReferences} onChange={(v) => updateTrip('previousTripReferences', v)} rows={2} placeholder="References to remove from older trips." />
                <TextInput label="Final approval contact" tip="Who signs off on this brochure before it is sent to the school." value={tripInput.finalApprovalContact} onChange={(v) => updateTrip('finalApprovalContact', v)} placeholder="Name / email" />

                <ModelPicker
                  catalog={catalog}
                  selectedModel={reasoningModel}
                  onChange={setReasoningModel}
                  running={running}
                  aiProvider={aiProvider}
                  aiError={aiError}
                />

                {touched && validationErrors.length > 0 && (
                  <div style={{ ...warningBanner, marginTop: 16 }} data-testid="validation-summary">
                    <AlertTriangle size={18} />
                    <div style={{ flex: 1 }}>
                      <strong>{validationErrors.length} required field{validationErrors.length === 1 ? '' : 's'} missing</strong>
                      <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                        {validationErrors.slice(0, 5).map((e) => {
                          const stepFor = e.path.startsWith('school') || e.path.startsWith('tmc') ? 1 : e.path.startsWith('days') ? 3 : ['currency', 'pricePerPerson', 'occupancyBasis', 'deposit', 'inclusions', 'exclusions', 'themeMode', 'travelSeason'].some((p) => e.path.startsWith(p)) ? 4 : ['primaryPhone', 'email', 'website', 'callToAction'].includes(e.path) ? 5 : 2;
                          return (
                            <li key={e.path}>
                              <button
                                type="button"
                                onClick={() => {
                                  setStep(stepFor);
                                  document.getElementById('brochure-step-progress')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }}
                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                              >
                                {e.msg}
                              </button>
                            </li>
                          );
                        })}
                        {validationErrors.length > 5 && <li>…and {validationErrors.length - 5} more</li>}
                      </ul>
                    </div>
                  </div>
                )}

                <div style={floatingNavBar}>
                  <button type="button" onClick={() => goToStep(4)} style={{ ...secondaryBtn, flex: '0 0 auto' }}>
                    <ArrowLeft size={14} /> Back
                  </button>
                  <button
                    type="submit"
                    disabled={running || aiError}
                    style={(running || aiError) ? disabledPrimaryBtn : primaryBtn}
                    data-testid="generate-brochure"
                    title={!isFormValid && touched ? 'Fill all required fields' : ''}
                  >
                    {running ? <><Loader size={16} className="anim-spin" /> Generating…</> : <><Sparkles size={16} /> Generate brochure</>}
                  </button>
                  {running && (
                    <button type="button" onClick={handleStop} data-testid="stop-brochure" style={{ ...secondaryBtn, borderColor: '#e06a5a', color: '#e06a5a' }}>
                      <X size={14} /> Stop
                    </button>
                  )}
                </div>
              </StepCard>
            </div>

            {step < 5 && (
              <div style={floatingNavBar}>
                <button type="button" onClick={() => goToStep(step - 1)} style={{ ...secondaryBtn, opacity: step === 1 ? 0.5 : 1 }} disabled={step === 1 || running}>
                  <ArrowLeft size={14} /> Back
                </button>
                <button type="button" onClick={() => goToStep(step + 1)} style={{ ...primaryBtn, width: 'auto' }} disabled={running} data-testid="next-step">
                  Next <ArrowRight size={14} />
                </button>
              </div>
            )}
          </form>

          {/* Trace / result */}
          {activeRunId && (
            <div style={{ ...stepCard, marginTop: 16 }}>
              <div style={stepHeader}>
                <div style={stepIcon}><Users size={20} /></div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Live trace</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>Run id: {activeRunId}</p>
                </div>
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                <button type="button" onClick={() => setShowRawTrace((v) => !v)} style={rawToggleBtn}>
                  {showRawTrace ? '− Hide' : '+ Show'} raw event log ({traceEvents.length})
                </button>
                {showRawTrace && (
                  <div style={traceBox}>
                    {traceEvents.map((e, i) => <TraceLine key={i} event={e} />)}
                  </div>
                )}
                {runError && (
                  <div style={errorBox}><AlertTriangle size={16} /> {runError}</div>
                )}
                {result && (
                  <div style={resultBox}>
                    <div style={resultHeader}>
                      <CheckCircle2 size={18} color="var(--primary-color, var(--accent-color))" />
                      <span style={{ fontWeight: 600 }}>Brochure ready</span>
                      {result.billedUsd != null && <span style={costBadge}>${Number(result.billedUsd).toFixed(4)}</span>}
                      {result.pdfUrl ? (
                        <>
                          <a href={brochureProxyUrl(activeBrochureIdRef.current, { inline: true })} target="_blank" rel="noopener noreferrer" style={{ ...secondaryBtn, marginLeft: 'auto', textDecoration: 'none' }}>Open</a>
                          <a href={brochureProxyUrl(activeBrochureIdRef.current)} download style={{ ...secondaryBtn, textDecoration: 'none' }}>Download</a>
                        </>
                      ) : (
                        <button type="button" onClick={() => activeBrochureIdRef.current && backfillPdfUrl(activeBrochureIdRef.current)} style={{ ...secondaryBtn, marginLeft: 'auto' }}>Fetch PDF</button>
                      )}
                    </div>
                    {result.pdfUrl ? (
                      <iframe src={pdfBlobUrl || result.pdfUrl} title="Brochure preview" style={pdfFrame} />
                    ) : (
                      <div style={{ ...emptyStyle, padding: 16 }}>Locating the rendered PDF…</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'history' && (
        <div style={stepCard}>
          <div style={stepHeader}>
            <div style={stepIcon}><HistoryIcon size={20} /></div>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Brochure history</h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>Past runs and PDFs</p>
            </div>
          </div>
          <div style={{ padding: '0 16px 16px' }}>
            {historyLoading && <div style={emptyStyle}>Loading…</div>}
            {!historyLoading && history.length === 0 && (
              <div style={emptyStyle}>No brochures generated yet. Switch to <strong>Generate</strong> to make your first one.</div>
            )}
            {!historyLoading && history.length > 0 && (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Created</th>
                    <th style={th}>Brief</th>
                    <th style={th}>Status</th>
                    <th style={th}>Cost</th>
                    <th style={th} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td style={td}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{new Date(row.createdAt).toLocaleString()}</div></td>
                      <td style={{ ...td, maxWidth: 360 }}><div style={ellipsis2}>{row.goal || row.tripInput?.tripTitle || '—'}</div></td>
                      <td style={td}>
                        <StatusBadge status={row.status} />
                        {row.errorMessage && <div style={{ fontSize: 11, color: '#b00', marginTop: 4 }} title={row.errorMessage}>{row.errorMessage.slice(0, 80)}</div>}
                      </td>
                      <td style={td}>{row.billedUsd != null ? `$${Number(row.billedUsd).toFixed(4)}` : '—'}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {row.pdfUrl && <a href={brochureProxyUrl(row.id, { inline: true })} target="_blank" rel="noopener noreferrer" style={iconBtn} title="Open PDF"><ExternalLink size={14} /></a>}
                          {row.pdfUrl && <a href={brochureProxyUrl(row.id)} download style={iconBtn} title="Download"><Download size={14} /></a>}
                          <button type="button" onClick={() => handleArchive(row)} style={iconBtn} title="Archive"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {confirmState && (
        <div
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) resolveConfirm(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            // Opaque enough that the dimmed page behind genuinely reads as
            // "background, don't look here" rather than legible/distracting
            // content peeking through around the dialog's edges — plus a
            // blur so nothing behind it is sharp even where it does show.
            background: 'rgba(10, 12, 20, 0.68)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            style={{
              background: 'var(--surface-color, #ffffff)', color: 'var(--text-primary)', borderRadius: 12,
              border: '1px solid var(--border-color)', boxShadow: '0 20px 60px rgba(0,0,0,0.45)', maxWidth: 460,
              width: '100%', padding: 20, isolation: 'isolate',
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 20 }}>
              <AlertTriangle size={20} style={{ color: confirmState.danger ? '#e06a5a' : 'var(--text-secondary)', flex: '0 0 auto', marginTop: 2 }} />
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{confirmState.message}</p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => resolveConfirm(false)} style={secondaryBtn} autoFocus>Cancel</button>
              {confirmState.onCheckNow && (
                <button type="button" onClick={checkNowConfirm} style={secondaryBtn}>Check now</button>
              )}
              <button
                type="button"
                onClick={() => resolveConfirm(true)}
                style={confirmState.danger ? { ...primaryBtn, width: 'auto', background: '#e06a5a' } : { ...primaryBtn, width: 'auto' }}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </FormTouchedContext.Provider>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const pageHeaderRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 };
const pageTitle = { display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: 24 };
const pageSubtitle = { color: 'var(--text-secondary)', marginTop: 6, maxWidth: 640, fontSize: 14 };
const tabBar = { display: 'flex', gap: 4, background: 'var(--subtle-bg)', borderRadius: 8, padding: 4 };
const tabBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13, background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' };
const activeTabBtn = { ...tabBtn, background: 'var(--surface-color)', color: 'var(--primary-color, var(--accent-color))', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' };

const stepCard = { background: 'var(--surface-color)', borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: 16, overflow: 'hidden' };
const stepHeader = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-color)' };
const stepIcon = { width: 36, height: 36, borderRadius: 8, background: 'var(--subtle-bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-color, var(--accent-color))' };

const progressBar = { display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' };
// Keep navigation in normal document flow. A sticky bottom bar can overlap
// the final form fields when the travel layout's main scroller is shorter
// than the form, which makes labels and inputs appear behind the controls.
const floatingNavBar = {
  position: 'relative',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
  marginTop: 16,
  marginBottom: 16,
  padding: 12,
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
  boxSizing: 'border-box',
};
const progressStep = { display: 'inline-flex', alignItems: 'center', padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'all 0.15s ease' };

const importCard = { background: 'var(--subtle-bg)', borderRadius: 10, border: '1px solid var(--border-color)', padding: 16, marginBottom: 20 };

const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 };
const sectionTitle = { margin: '20px 0 12px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: 6 };
const inputStyle = { padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', fontSize: 14, width: '100%', boxSizing: 'border-box', lineHeight: 1.4 };
const selectStyle = { ...inputStyle, background: 'var(--surface-color)' };

const primaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderRadius: 8, fontWeight: 600, fontSize: 14, background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', cursor: 'pointer', width: '100%', justifyContent: 'center' };
const disabledPrimaryBtn = { ...primaryBtn, opacity: 0.6, cursor: 'not-allowed' };
const secondaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14, background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', cursor: 'pointer' };
const chipBtn = { fontSize: 12, padding: '6px 12px', borderRadius: 16, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-secondary)', cursor: 'pointer' };
const iconBtn = { padding: 6, borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' };

const emptyStyle = { padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 };
const warningBanner = { padding: 12, borderRadius: 8, background: 'rgba(224, 106, 90, 0.08)', border: '1px solid rgba(224, 106, 90, 0.35)', color: 'var(--text-primary)', fontSize: 14, display: 'flex', alignItems: 'flex-start', gap: 10 };
const errorBox = { marginTop: 12, padding: 12, borderRadius: 8, background: 'rgba(176,0,0,0.08)', border: '1px solid rgba(176,0,0,0.25)', color: '#b00', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 };
const resultBox = { marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--subtle-bg)', border: '1px solid var(--border-color)' };
const resultHeader = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' };
const costBadge = { padding: '2px 8px', borderRadius: 12, background: 'var(--subtle-bg-3)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 };
const pdfFrame = { width: '100%', height: 480, border: '1px solid var(--border-color)', borderRadius: 8, background: 'white' };

const rawToggleBtn = { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', padding: '4px 0', textAlign: 'left' };
const traceBox = { background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, maxHeight: 280, overflowY: 'auto', marginBottom: 8 };
const traceLine = { display: 'flex', gap: 6, padding: '2px 4px', borderBottom: '1px dashed var(--border-color)', alignItems: 'baseline' };
const traceType = { color: 'var(--primary-color, var(--accent-color))', minWidth: 130, fontWeight: 600 };
const traceAgent = { color: 'var(--text-primary)', minWidth: 80 };
const traceData = { color: 'var(--text-secondary)', wordBreak: 'break-word', flex: 1 };

const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const th = { textAlign: 'left', padding: '12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', background: 'var(--subtle-bg)' };
const td = { padding: '12px', fontSize: 14, color: 'var(--text-primary)', verticalAlign: 'top', borderBottom: '1px solid var(--border-color)' };
const ellipsis2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis' };
