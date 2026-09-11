import React, { useEffect, useMemo, useRef, useState, useContext } from "react";
import { createPortal } from "react-dom";
import {
  Calendar,
  RefreshCw,
  ExternalLink,
  Check,
  Plug,
  Trash2,
  X,
  Users,
  Video,
  Plus,
  AlertTriangle,
} from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { AuthContext } from "../App";

const PROVIDERS = [
  {
    key: "google",
    label: "Google Calendar",
    color: "#4285F4",
    bg: "rgba(66,133,244,0.10)",
    initials: "G",
  },
  {
    key: "outlook",
    label: "Microsoft Outlook",
    color: "#0078D4",
    bg: "rgba(0,120,212,0.10)",
    initials: "O",
  },
];

const BIRTHDAY_BASE_YEAR = 2000;
const BIRTHDAY_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function getDaysInMonth(monthIndex, year = BIRTHDAY_BASE_YEAR) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function getBirthdayMonthDayKey(monthIndex, day) {
  const month = Number(monthIndex);
  const dayNum = Number(day);
  if (!Number.isInteger(month) || !Number.isInteger(dayNum)) return "";
  return `${String(month).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
}

function buildBirthdayDate(monthIndex, day) {
  const month = Number(monthIndex);
  const dayNum = Number(day);
  if (!Number.isInteger(month) || !Number.isInteger(dayNum)) return null;
  return new Date(Date.UTC(BIRTHDAY_BASE_YEAR, month, dayNum, 12, 0, 0));
}

function formatLocalDateKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildBirthdayCalendarPayload(name, birthDate) {
  const nextBirthday = buildNextBirthday({ birthDate }, new Date());
  if (!nextBirthday) return null;
  const startDate = formatLocalDateKey(nextBirthday);
  if (!startDate) return null;
  const endDateObj = new Date(nextBirthday);
  endDateObj.setDate(endDateObj.getDate() + 1);
  const endDate = formatLocalDateKey(endDateObj);
  if (!endDate) return null;
  return {
    title: `${name} birthday`,
    description: "Birthday",
    startDate,
    endDate,
    allDay: true,
    transparency: "transparent",
    recurrence: ["RRULE:FREQ=YEARLY"],
  };
}

function normalizeBirthdayName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+birthday\s*$/i, "")
    .toLowerCase();
}

function getBirthdayDateKey(value) {
  const date = safeDate(value);
  if (!date) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function Toast({ msg, onClose }) {
  // Infer success vs error from the message so failures show red (with an
  // alert icon) instead of a misleading green checkmark. Error toasts also
  // linger longer so the user can actually read a "please reconnect" prompt.
  const isError =
    /\b(fail|error|expired|reconnect|couldn|could not|denied|invalid|unable|not connected|no sync)\b/i.test(
      msg || "",
    );
  useEffect(() => {
    const t = setTimeout(onClose, isError ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [onClose, isError]);
  return (
    <div
      style={{
        position: "fixed",
        top: "1.5rem",
        right: "1.5rem",
        zIndex: 9999,
        background: isError ? "rgba(239,68,68,0.96)" : "rgba(34,197,94,0.95)",
        color: "#fff",
        padding: "0.75rem 1.25rem",
        borderRadius: "10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        display: "flex",
        alignItems: "flex-start",
        gap: "0.5rem",
        backdropFilter: "blur(8px)",
        maxWidth: "380px",
        lineHeight: 1.4,
        fontSize: "0.875rem",
      }}
    >
      {isError ? (
        <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
      ) : (
        <Check size={18} style={{ flexShrink: 0, marginTop: 1 }} />
      )}
      <span>{msg}</span>
    </div>
  );
}

function formatDateTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function attendeeCount(att) {
  if (!att) return 0;
  try {
    const arr = typeof att === "string" ? JSON.parse(att) : att;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function getMeetingStatus(event, now = new Date()) {
  const start = safeDate(event?.startTime);
  const end = safeDate(event?.endTime) || start;
  if (!start || !end) return "upcoming";
  if (start.getTime() <= now.getTime() && end.getTime() > now.getTime()) {
    return "in-progress";
  }
  if (end.getTime() <= now.getTime()) return "completed";
  return "upcoming";
}

function parseLocalDateTime(value) {
  if (value instanceof Date) return safeDate(value);
  if (typeof value === "string") {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "0"] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      0,
    );
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return safeDate(value);
}

function floorToMinute(date) {
  const safe = parseLocalDateTime(date);
  if (!safe) return null;
  safe.setSeconds(0, 0);
  return safe;
}

function localDateTimeInputValue(date) {
  const safe = floorToMinute(date);
  if (!safe) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(safe.getDate())}T${pad(safe.getHours())}:${pad(safe.getMinutes())}`;
}

function currentLocalDateTimeMin() {
  return localDateTimeInputValue(new Date());
}

function openNativePicker(e) {
  const input = e?.currentTarget;
  if (!input) return;
  if (typeof input.showPicker === "function") {
    try {
      input.showPicker();
    } catch {
      // Ignore browsers that expose showPicker but still refuse the call.
    }
  }
}

function blockManualDateEntry(e) {
  if (e?.key === "Tab") return;
  e.preventDefault();
  if (e?.key === "Enter" || e?.key === " ") {
    openNativePicker(e);
  }
}

function monthLabel(date) {
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function monthNameFromIndex(monthIndex) {
  const index = Number(monthIndex);
  if (!Number.isInteger(index) || index < 0 || index > 11) return "";
  return BIRTHDAY_MONTHS[index];
}

function getMonthIndexKey(date) {
  const safe = safeDate(date);
  if (!safe) return "";
  return String(safe.getMonth());
}

function buildNextBirthday(contact, now = new Date()) {
  const birth = safeDate(contact?.birthDate);
  if (!birth) return null;
  const candidate = new Date(now.getFullYear(), birth.getMonth(), birth.getDate(), 9, 0, 0, 0);
  if (candidate < now) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return candidate;
}

function formatShortDate(date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const TRAVEL_BRAND_LABELS = {
  tmc: "TMC",
  rfu: "RFU",
  travelstall: "Travel Stall",
  travel_stall: "Travel Stall",
  visasure: "Visa Sure",
  visa_sure: "Visa Sure",
};

function normalizeBrandKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function formatBrandLabel(value) {
  const key = normalizeBrandKey(value);
  return TRAVEL_BRAND_LABELS[key] || (value ? String(value) : "Unspecified");
}

function formatStatusLabel(value) {
  const text = String(value || "unknown").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatPersonStatus(participant) {
  if (participant?.applicationStatus) {
    return formatStatusLabel(participant.applicationStatus);
  }
  if (participant?.passportRejectedAt) return "Passport rejected";
  if (participant?.passportVerifiedAt) return "Passport verified";
  if (participant?.passportExtractedAt) return "Passport extracted";
  return "Pending";
}

function isConfirmedTravelTrip(record, source) {
  const status = String(record?.status || "").toLowerCase();
  if (source === "tmcTrip") return status === "confirmed";
  return ["confirmed", "accepted", "advance_paid", "fully_paid", "paid"].includes(status);
}

function normalizeTravelTrip(record, source) {
  const subBrand = normalizeBrandKey(record?.subBrand || (source === "tmcTrip" ? "tmc" : ""));
  const startDate = safeDate(record?.departDate || record?.startDate || record?.createdAt);
  const endDate = safeDate(record?.returnDate || record?.endDate);
  return {
    ...record,
    _source: source,
    _subBrand: subBrand || "unspecified",
    _subBrandLabel: formatBrandLabel(subBrand || "unspecified"),
    _statusKey: String(record?.status || "unknown").toLowerCase(),
    _statusLabel: formatStatusLabel(record?.status),
    _startDate: startDate,
    _endDate: endDate,
    _title:
      record?.destination
      || record?.tripCode
      || record?.contact?.name
      || `Trip #${record?.id}`,
    _who:
      source === "tmcTrip"
        ? record?.schoolName || record?.contact?.name || "TMC trip"
        : record?.contact?.name || "Itinerary",
  };
}

function getTripPersonSummary(trip, detail) {
  if (!trip) return { count: 0, people: [] };

  if (trip._source === "tmcTrip") {
    const participants = Array.isArray(detail?.participants)
      ? detail.participants
      : Array.isArray(trip?.participants)
        ? trip.participants
        : [];
    return {
      count:
        participants.length ||
        Number(detail?._count?.participants || trip?._count?.participants || 0) ||
        0,
      people: participants.map((participant) => ({
        id: participant.id,
        name: participant.fullName || "Passenger",
        role: "Participant",
        parentName: participant.parentName || "",
        parentPhone: participant.parentPhone || "",
        status: formatPersonStatus(participant),
        consent: participant.consentCapturedAt ? "Consent captured" : "",
        note: participant.reviewNotes || "",
      })),
    };
  }

  const contact = detail?.contact || trip?.contact || null;
  const paxValue = Number(detail?.pax ?? trip?.pax);
  const count = Number.isFinite(paxValue) && paxValue > 0 ? paxValue : contact ? 1 : 0;
  return {
    count,
    people: contact
      ? [
          {
            id: contact.id || "contact",
            name: contact.name || "Primary traveler",
            role: "Primary traveler",
            email: contact.email || "",
            phone: contact.phone || "",
            status: count > 1 ? `${count} travelers on itinerary` : "Primary contact",
          },
        ]
      : [],
  };
}

const CALENDAR_SYNC_SEEN_STORAGE_KEY = "calendar-sync-seen-alerts-v1";
const CALENDAR_SYNC_DISMISSED_STORAGE_KEY = "calendar-sync-dismissed-alerts-v1";
const CALENDAR_SYNC_MANUAL_BIRTHDAYS_KEY = "calendar-sync-manual-birthdays-v1";

function createBirthdayDraft() {
  return {
    manualName: "",
    birthMonth: "",
    birthDay: "",
  };
}

function normalizeManualBirthdayEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const monthIndex = Number(entry.birthMonth);
  const day = Number(entry.birthDay);
  if (!Number.isInteger(monthIndex) || !Number.isInteger(day)) return null;
  const birthDate = buildBirthdayDate(monthIndex, day);
  if (!birthDate) return null;
  return {
    id: entry.id || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: "manual",
    name: entry.name || entry.manualName || "Manual birthday",
    manualName: entry.manualName || entry.name || "Manual birthday",
    birthMonth: String(monthIndex),
    birthDay: String(day),
    birthDate: birthDate.toISOString(),
    sourceLabel: "Manual birthday",
    canDelete: true,
    linkedGoogleEventId: entry.linkedGoogleEventId || entry.googleEventId || entry.externalEventId || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  };
}

function readSeenAlertState() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALENDAR_SYNC_SEEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readDismissedAlertState() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALENDAR_SYNC_DISMISSED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readManualBirthdayState() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CALENDAR_SYNC_MANUAL_BIRTHDAYS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map(normalizeManualBirthdayEntry).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function getTripAlertKey(trip) {
  return `trip-${trip?._source || "unknown"}-${trip?.id}`;
}

function getBirthdayAlertKey(contact) {
  return `birthday-${contact?.source || "contact"}-${contact?.id}`;
}

const MEETING_REMINDER_WINDOWS = [
  { key: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "30m", label: "30 minutes", ms: 30 * 60 * 1000 },
  { key: "10m", label: "10 minutes", ms: 10 * 60 * 1000 },
];

const CALENDAR_SYNC_CARD_STYLE = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  boxShadow: "0 16px 40px rgba(0,0,0,0.10)",
  backdropFilter: "blur(12px)",
};

const CALENDAR_SYNC_DIALOG_STYLE = {
  background: "var(--modal-bg, #ffffff)",
  border: "1px solid var(--border-color)",
  boxShadow: "0 28px 72px rgba(0,0,0,0.22)",
};

const CALENDAR_SYNC_ITEM_STYLE = {
  background: "var(--surface-hover)",
  border: "1px solid var(--border-color)",
};
const CALENDAR_SYNC_MAX_RENDERED_MEETINGS = 50;

function getMeetingReminderAlertKey(event, reminderKey) {
  return `meeting-${event?._provider || "unknown"}-${event?.id}-${reminderKey}`;
}

function getActiveMeetingReminderWindow(timeUntilStart) {
  for (let index = MEETING_REMINDER_WINDOWS.length - 1; index >= 0; index -= 1) {
    const reminderWindow = MEETING_REMINDER_WINDOWS[index];
    if (timeUntilStart <= reminderWindow.ms) return reminderWindow;
  }
  return null;
}

function isBirthdayLikeEvent(event) {
  const text = `${event?.title || ""} ${event?.description || ""}`.toLowerCase();
  const calendarName = String(event?.calendarId || event?.calendar || "").toLowerCase();
  return (
    text.includes("birthday") ||
    calendarName.includes("birthday")
  );
}

function getAlertNotificationTime(alert) {
  const baseTime = alert?.when ? new Date(alert.when).getTime() : NaN;
  if (!Number.isFinite(baseTime)) return null;

  if (alert?.kind === "Meeting") {
    const reminderWindow =
      MEETING_REMINDER_WINDOWS.find((window) => window.key === alert?.reminderKey) ||
      MEETING_REMINDER_WINDOWS[0];
    return new Date(baseTime - reminderWindow.ms);
  }

  // Trips and birthdays use the 24h reminder by default.
  return new Date(baseTime - 24 * 60 * 60 * 1000);
}

export default function CalendarSync() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const tenantVertical = user?.tenant?.vertical || "generic";
  const isTravelTenant = tenantVertical === "travel";
  // Travel tenants only use Google Calendar; generic + wellness keep both.
  const availableProviders = PROVIDERS.filter((p) =>
    tenantVertical === "travel" ? p.key === "google" : true,
  );
  const [status, setStatus] = useState({
    google: { connected: false, lastSyncAt: null },
    outlook: { connected: false, lastSyncAt: null },
  });
  const [events, setEvents] = useState([]);
  const [travelTrips, setTravelTrips] = useState([]);
  const [birthdayContacts, setBirthdayContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({ google: false, outlook: false });
  const [toast, setToast] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createProvider, setCreateProvider] = useState("");
  const [activeTab, setActiveTab] = useState(() =>
    tenantVertical === "travel" ? "trips" : "meetings",
  );
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    startTime: "",
    endTime: "",
    attendees: "",
    location: "",
    createMeet: false,
    createZoom: false,
  });
  const [showEventDetail, setShowEventDetail] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [isEditingEvent, setIsEditingEvent] = useState(false);
  const [editFormData, setEditFormData] = useState({});
  const [showTripDetail, setShowTripDetail] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [selectedTripDetail, setSelectedTripDetail] = useState(null);
  const [tripDetailLoading, setTripDetailLoading] = useState(false);
  const [tripDetailError, setTripDetailError] = useState("");
  const [showBirthdayModal, setShowBirthdayModal] = useState(false);
  const [birthdaySaving, setBirthdaySaving] = useState(false);
  const [birthdayError, setBirthdayError] = useState("");
  const [manualBirthdayEntries, setManualBirthdayEntries] = useState(() => readManualBirthdayState());
  const [birthdayForm, setBirthdayForm] = useState(() => createBirthdayDraft());
  const [birthdayMonthFilter, setBirthdayMonthFilter] = useState(() => String(new Date().getMonth()));
  const [meetingStatusFilter, setMeetingStatusFilter] = useState("upcoming");
  const [meetingDateFilter, setMeetingDateFilter] = useState("");
  const tripDetailRequestId = useRef(0);
  const detailsSectionRef = useRef(null);
  const alertsSectionRef = useRef(null);
  const [openPanel, setOpenPanel] = useState("details");
  const [seenAlertKeys, setSeenAlertKeys] = useState(() => readSeenAlertState());
  const [dismissedAlertKeys, setDismissedAlertKeys] = useState(() => readDismissedAlertState());
  const [alertClock, setAlertClock] = useState(() => Date.now());
  // T18 slot-picker (Google only): pick a day → fetch free/busy slots →
  // click a slot to fill start/end. Purely additive; leaving it untouched
  // keeps the manual datetime inputs as the source of truth.
  const [slotPicker, setSlotPicker] = useState({
    date: "",
    slots: [],
    loading: false,
    error: "",
  });
  // Attendee picker — contacts/customers fetched lazily when the modal opens.
  const [contactOptions, setContactOptions] = useState([]);
  const createStartTime = floorToMinute(formData.startTime);
  const createEndTime = floorToMinute(formData.endTime);
  const createNow = floorToMinute(new Date());
  const createStartIsPast =
    !!createStartTime &&
    !!createNow &&
    createStartTime.getTime() < createNow.getTime();
  const createEndIsInvalid =
    !!createStartTime &&
    !!createEndTime &&
    createEndTime.getTime() <= createStartTime.getTime();

  // Detect ?connected=google|outlook in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get("connected");
    const err = params.get("error");
    if (c === "google" || c === "outlook") {
      setToast(`${c === "google" ? "Google" : "Outlook"} Calendar connected!`);
      // Clean the URL
      window.history.replaceState({}, "", window.location.pathname);
    } else if (err) {
      setToast(`Connection failed: ${err}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const loadAll = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const next = {
      google: { connected: false, lastSyncAt: null },
      outlook: { connected: false, lastSyncAt: null },
    };
    const collected = [];
    const nextTrips = [];
    const nextBirthdays = [];
    await Promise.all(
      availableProviders.map(async (p) => {
        try {
          if (p.key === "google") {
            try {
              await fetchApi("/api/calendar/google/sync", { method: "POST", silent: true });
            } catch {
              // Best-effort refresh only. Fall through to the cached list fetch.
            }
          }
          const evs = await fetchApi(`/api/calendar/${p.key}/events`);
          if (Array.isArray(evs)) {
            next[p.key].connected = true;
            // Find most recent event's update for "last sync" fallback
            evs.forEach((e) => collected.push({ ...e, _provider: p.key }));
            // Try to fetch integration metadata if route exposes it later, fallback: most recent event time
            const latest = evs.reduce((acc, e) => {
              const t = new Date(e.updatedAt || e.startTime || 0).getTime();
              return t > acc ? t : acc;
            }, 0);
            if (latest) next[p.key].lastSyncAt = new Date(latest).toISOString();
          }
        } catch {
          // not connected or endpoint unavailable — ignore
        }
      }),
    );

    if (isTravelTenant) {
      const [itineraryResult, tripsResult] = await Promise.allSettled([
        fetchApi("/api/travel/itineraries?limit=150&fields=summary", { silent: true }),
        fetchApi("/api/travel/trips?limit=150&fields=summary", { silent: true }),
      ]);

      if (itineraryResult.status === "fulfilled") {
        const itineraryRes = itineraryResult.value;
        const itineraries = Array.isArray(itineraryRes)
          ? itineraryRes
          : itineraryRes?.itineraries || itineraryRes?.data || [];
        itineraries
          .map((trip) => normalizeTravelTrip(trip, "itinerary"))
          .filter((trip) => isConfirmedTravelTrip(trip, trip._source))
          .forEach((trip) => nextTrips.push(trip));
      }

      if (tripsResult.status === "fulfilled") {
        const tripsRes = tripsResult.value;
        const trips = Array.isArray(tripsRes)
          ? tripsRes
          : tripsRes?.trips || tripsRes?.data || [];
        trips
          .map((trip) => normalizeTravelTrip(trip, "tmcTrip"))
          .filter((trip) => isConfirmedTravelTrip(trip, trip._source))
          .forEach((trip) => nextTrips.push(trip));
      }
    }

    try {
      const contactsRes = await fetchApi("/api/contacts?limit=200", { silent: true });
      const contacts = Array.isArray(contactsRes)
        ? contactsRes
        : contactsRes?.data || contactsRes?.contacts || [];
      contacts
        .filter((contact) => contact && contact.birthDate)
        .forEach((contact) => nextBirthdays.push(contact));
      if (!contactOptions.length) {
        setContactOptions(
          contacts
            .filter((c) => c && c.email)
            .map((c) => ({
              id: c.id,
              name: c.name || c.email,
              email: c.email,
            })),
        );
      }
    } catch {
      // Best-effort only.
    }

    collected.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    nextTrips.sort((a, b) => (a._startDate?.getTime?.() || 0) - (b._startDate?.getTime?.() || 0));
    setStatus(next);
    setEvents(collected);
    setTravelTrips(nextTrips);
    setBirthdayContacts(nextBirthdays);
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!status.google.connected) return;
    const googleEventIds = new Set(
      events
        .filter((event) => event?._provider === "google")
        .map((event) => String(event.id)),
    );
    setManualBirthdayEntries((prev) =>
      prev.filter(
        (entry) => !entry.linkedGoogleEventId || googleEventIds.has(String(entry.linkedGoogleEventId)),
      ),
    );
  }, [events, status.google.connected]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CALENDAR_SYNC_MANUAL_BIRTHDAYS_KEY,
        JSON.stringify(manualBirthdayEntries),
      );
    } catch {
      // Ignore localStorage write failures and keep the UI working.
    }
  }, [manualBirthdayEntries]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CALENDAR_SYNC_SEEN_STORAGE_KEY,
        JSON.stringify(seenAlertKeys),
      );
    } catch {
      // Best-effort only.
    }
  }, [seenAlertKeys]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CALENDAR_SYNC_DISMISSED_STORAGE_KEY,
        JSON.stringify(dismissedAlertKeys),
      );
    } catch {
      // Best-effort only.
    }
  }, [dismissedAlertKeys]);

  useEffect(() => {
    const timerId = window.setInterval(() => setAlertClock(Date.now()), 30 * 1000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (!showTripDetail) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [showTripDetail]);

  const closeTripDetail = () => {
    tripDetailRequestId.current += 1;
    setShowTripDetail(false);
    setSelectedTrip(null);
    setSelectedTripDetail(null);
    setTripDetailLoading(false);
    setTripDetailError("");
  };

  const openTripDetail = async (trip) => {
    if (!trip) return;
    const requestId = tripDetailRequestId.current + 1;
    tripDetailRequestId.current = requestId;
    setSelectedTrip(trip);
    setSelectedTripDetail(null);
    setTripDetailError("");
    setTripDetailLoading(true);
    setShowTripDetail(true);
    const endpoint =
      trip._source === "tmcTrip"
        ? `/api/travel/trips/${trip.id}`
        : `/api/travel/itineraries/${trip.id}`;
    try {
      const detail = await fetchApi(endpoint, { silent: true });
      if (tripDetailRequestId.current !== requestId) return;
      setSelectedTripDetail(detail);
    } catch (error) {
      if (tripDetailRequestId.current !== requestId) return;
      setTripDetailError(
        error?.message || "Could not load trip details right now.",
      );
      setSelectedTripDetail(null);
    } finally {
      if (tripDetailRequestId.current === requestId) {
        setTripDetailLoading(false);
      }
    }
  };

  const tabOptions = useMemo(() => {
    const tabs = [
      { key: "meetings", label: "Meetings" },
      { key: "birthdays", label: "Birthdays" },
    ];
    if (isTravelTenant) {
      tabs.unshift({ key: "trips", label: "Travel Trips" });
    }
    return tabs;
  }, [isTravelTenant]);

  useEffect(() => {
    if (!tabOptions.some((tab) => tab.key === activeTab)) {
      setActiveTab(tabOptions[0]?.key || "meetings");
    }
  }, [activeTab, tabOptions]);

  const travelTripRows = useMemo(() => {
    return travelTrips
      .map((trip) => ({
        ...trip,
        _startDate: trip._startDate || safeDate(trip.departDate || trip.startDate || trip.createdAt),
        _endDate: trip._endDate || safeDate(trip.returnDate || trip.endDate),
      }))
      .sort((a, b) => (a._startDate?.getTime?.() || 0) - (b._startDate?.getTime?.() || 0));
  }, [travelTrips]);

  const birthdayRows = useMemo(() => {
    const now = new Date();
    const calendarBirthdayEvents = events.filter((event) => isBirthdayLikeEvent(event));
    const calendarBirthdayEventIds = new Set(calendarBirthdayEvents.map((event) => String(event?.id)));

    const contactRows = birthdayContacts
      .map((contact) => {
        const birth = safeDate(contact.birthDate);
        if (!birth) return null;
        const nextBirthday = buildNextBirthday(contact, now);
        if (!nextBirthday) return null;
        return {
          ...contact,
          source: "contact",
          sourceLabel: "Contact birthday",
          canDelete: true,
          birthDateObj: birth,
          nextBirthday,
          monthKey: `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, "0")}`,
        };
      })
      .filter(Boolean);

    const manualRows = manualBirthdayEntries
      .filter((entry) => !entry.linkedGoogleEventId || !calendarBirthdayEventIds.has(String(entry.linkedGoogleEventId)))
      .map((entry) => {
        const monthIndex = Number(entry.birthMonth);
        const day = Number(entry.birthDay);
        const birth = buildBirthdayDate(monthIndex, day);
        if (!birth) return null;
        const nextBirthday = buildNextBirthday({ birthDate: birth }, now);
        if (!nextBirthday) return null;
        return {
          ...entry,
          id: entry.id,
          name: entry.manualName || entry.name || "Manual birthday",
          source: "manual",
          sourceLabel: "Manual birthday",
          canDelete: true,
          birthDateObj: birth,
          nextBirthday,
          monthKey: `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, "0")}`,
        };
      })
      .filter(Boolean);

    const calendarRows = calendarBirthdayEvents
      .map((event) => {
        const birth = safeDate(event.startTime || event.start || event.date);
        if (!birth) return null;
        const nextBirthday = buildNextBirthday({ birthDate: birth }, now);
        if (!nextBirthday) return null;
        return {
          id: `${event._provider || "calendar"}-${event.id}`,
          name: event.title || "Calendar birthday",
          email: "",
          source: "calendar",
          sourceLabel: `${PROVIDERS.find((p) => p.key === event._provider)?.label || "Calendar"} birthday`,
          canDelete: true,
          birthdayEvent: event,
          birthDateObj: birth,
          nextBirthday,
          monthKey: `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, "0")}`,
        };
      })
      .filter(Boolean)
      .reduce((rows, row) => {
        const rowKey = `${normalizeBirthdayName(row.name)}-${row.monthKey}`;
        if (rows.some((existing) => `${normalizeBirthdayName(existing.name)}-${existing.monthKey}` === rowKey)) {
          return rows;
        }
        rows.push(row);
        return rows;
      }, []);

    return [...contactRows, ...manualRows, ...calendarRows].sort((a, b) => a.nextBirthday - b.nextBirthday);
  }, [birthdayContacts, manualBirthdayEntries, events]);

  const birthdayMonthOptions = useMemo(() => {
    return BIRTHDAY_MONTHS.map((label, index) => ({
      value: String(index),
      label,
    }));
  }, []);

  useEffect(() => {
    const currentMonthKey = String(new Date().getMonth());
    if (!birthdayMonthFilter && currentMonthKey) {
      setBirthdayMonthFilter(currentMonthKey);
      return;
    }
    if (birthdayMonthFilter === "all") return;
    const hasSelected = birthdayMonthOptions.some((option) => option.value === birthdayMonthFilter);
    if (!hasSelected) {
      setBirthdayMonthFilter(currentMonthKey);
    }
  }, [birthdayMonthFilter, birthdayMonthOptions]);

  const filteredBirthdayRows = useMemo(() => {
    if (!birthdayMonthFilter || birthdayMonthFilter === "all") {
      return birthdayRows;
    }
    return birthdayRows.filter((contact) => String(contact.nextBirthday.getMonth()) === birthdayMonthFilter);
  }, [birthdayMonthFilter, birthdayRows]);

  const selectedBirthdayMonthLabel = useMemo(() => {
    if (!birthdayMonthFilter || birthdayMonthFilter === "all") return "All months";
    return birthdayMonthOptions.find((option) => option.value === birthdayMonthFilter)?.label
      || monthNameFromIndex(birthdayMonthFilter)
      || "Current month";
  }, [birthdayMonthFilter, birthdayMonthOptions]);

  const meetingRows = useMemo(
    () => events.filter((event) => !isBirthdayLikeEvent(event)),
    [events],
  );

  const upcomingMeetingRows = useMemo(() => {
    const now = new Date();
    return meetingRows.filter((event) => {
      const start = safeDate(event.startTime);
      const end = safeDate(event.endTime) || start;
      return !end || end.getTime() >= now.getTime();
    });
  }, [meetingRows]);

  const filteredMeetingRows = useMemo(() => {
    const now = new Date();
    return meetingRows
      .filter((event) => {
        const start = safeDate(event.startTime);
        const end = safeDate(event.endTime) || start;
        const isCompleted = !!end && end.getTime() < now.getTime();
        if (meetingStatusFilter === "completed") return isCompleted;
        if (meetingStatusFilter === "upcoming") return !isCompleted;
        return true;
      })
      .filter((event) => {
        if (!meetingDateFilter) return true;
        const start = safeDate(event.startTime);
        if (!start) return false;
        return formatLocalDateKey(start) === meetingDateFilter;
      })
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      .slice(0, CALENDAR_SYNC_MAX_RENDERED_MEETINGS);
  }, [meetingDateFilter, meetingRows, meetingStatusFilter]);

  const pendingAlerts = useMemo(() => {
    const now = new Date(alertClock);
    const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const alerts = [];

    travelTripRows.forEach((trip) => {
      if (!trip._startDate) return;
      if (trip._startDate >= now && trip._startDate <= horizon) {
        alerts.push({
          key: getTripAlertKey(trip),
          kind: "Trip",
          title: trip._title || "Trip",
          when: trip._startDate,
          note: "Notify admin + school contact",
          trip,
        });
      }
    });

    birthdayRows.forEach((contact) => {
      if (!contact.nextBirthday) return;
      if (contact.nextBirthday >= now && contact.nextBirthday <= horizon) {
        alerts.push({
          key: getBirthdayAlertKey(contact),
          kind: "Birthday",
          title: contact.name || "Birthday",
          when: contact.nextBirthday,
          note: "Notify admin + concerned person",
          contact,
        });
      }
    });

    meetingRows.forEach((event) => {
      const start = safeDate(event.startTime);
      if (!start) return;
      const timeUntilStart = start.getTime() - now.getTime();
      if (timeUntilStart <= 0) return;
      const reminderWindow = getActiveMeetingReminderWindow(timeUntilStart);
      if (!reminderWindow) return;

      alerts.push({
        key: getMeetingReminderAlertKey(event, reminderWindow.key),
        kind: "Meeting",
        title: `${event.title || "Meeting"} (${reminderWindow.label})`,
        when: start,
        note: `Reminder: ${reminderWindow.label} before start`,
        event,
        reminderKey: reminderWindow.key,
        reminderLabel: reminderWindow.label,
      });
    });

    return alerts.sort((a, b) => a.when - b.when);
  }, [alertClock, birthdayRows, meetingRows, travelTripRows]);

  const visiblePendingAlerts = useMemo(
    () => pendingAlerts.filter((alert) => !dismissedAlertKeys[alert.key]),
    [pendingAlerts, dismissedAlertKeys],
  );

  const unreadAlerts = useMemo(
    () => visiblePendingAlerts.filter((alert) => !seenAlertKeys[alert.key]),
    [seenAlertKeys, visiblePendingAlerts],
  );

  const sortedPendingAlerts = useMemo(() => {
    return [...visiblePendingAlerts].sort((a, b) => {
      const aIsNew = !seenAlertKeys[a.key];
      const bIsNew = !seenAlertKeys[b.key];
      if (aIsNew !== bIsNew) return aIsNew ? -1 : 1;

      const aTime = getAlertNotificationTime(a)?.getTime?.() || 0;
      const bTime = getAlertNotificationTime(b)?.getTime?.() || 0;
      return bTime - aTime;
    });
  }, [visiblePendingAlerts, seenAlertKeys]);

  const birthdayGroups = useMemo(() => {
    const groups = new Map();
    filteredBirthdayRows.forEach((contact) => {
      const key = monthNameFromIndex(contact.nextBirthday.getMonth());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(contact);
    });
    return [...groups.entries()];
  }, [filteredBirthdayRows]);

  const selectedTripPeople = useMemo(
    () => getTripPersonSummary(selectedTrip, selectedTripDetail),
    [selectedTrip, selectedTripDetail],
  );

  const handleConnect = async (provider) => {
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      const res = await fetchApi(`/api/calendar/${provider}/connect`);
      if (res && res.authUrl) {
        window.location.href = res.authUrl;
      } else {
        setToast(`Failed to start ${provider} OAuth`);
      }
    } catch (e) {
      setToast(`Error: ${e.message || "Unable to connect"}`);
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  const handleSync = async (provider) => {
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      // silent: true → suppress fetchApi's global auto-toast so we don't show
      // two notifications; this page renders its own (error-styled) toast.
      const res = await fetchApi(`/api/calendar/${provider}/sync`, {
        method: "POST",
        silent: true,
      });
      setToast(`Synced ${res.synced ?? 0} ${provider} events`);
      await loadAll();
    } catch (e) {
      // The backend now returns a friendly, self-explanatory message (e.g.
      // "Your Microsoft Outlook connection has expired. Please reconnect…"),
      // so show it directly rather than prefixing/dumping a raw OAuth error.
      setToast(
        e.message ||
          `Couldn't sync ${provider === "google" ? "Google" : "Outlook"}. Please try again.`,
      );
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  const handleDisconnect = async (provider) => {
    if (
      !(await notify.confirm(
        `Disconnect ${provider} Calendar? Synced events will remain.`,
      ))
    )
      return;
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      await fetchApi(`/api/calendar/${provider}/disconnect`, {
        method: "DELETE",
      });
      setToast(
        `${provider === "google" ? "Google" : "Outlook"} Calendar disconnected`,
      );
      await loadAll();
    } catch (e) {
      setToast(`Disconnect failed: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  // Lazily fetch contacts/customers the first time the Create-Event modal
  // opens, to populate the attendee dropdown. Best-effort — failure just
  // leaves the manual email input as the only path.
  useEffect(() => {
    if ((!showCreateModal && !(showEventDetail && isEditingEvent)) || contactOptions.length) return;
    fetchApi("/api/contacts?limit=200")
      .then((res) => {
        const list = Array.isArray(res)
          ? res
          : res?.data || res?.contacts || [];
        setContactOptions(
          list
            .filter((c) => c && c.email)
            .map((c) => ({
              id: c.id,
              name: c.name || c.email,
              email: c.email,
            })),
        );
      })
      .catch(() => {});
  }, [showCreateModal, showEventDetail, isEditingEvent, contactOptions.length]);

  // Append an email to the comma-separated attendees field, de-duplicating.
  const addAttendeeEmail = (email) => {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) return;
    const current = formData.attendees
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (current.some((item) => item.toLowerCase() === normalizedEmail.toLowerCase())) return;
    setFormData({ ...formData, attendees: [...current, normalizedEmail].join(", ") });
  };

  const removeAttendeeEmail = (email) => {
    const remaining = formData.attendees
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && item.toLowerCase() !== String(email).toLowerCase());
    setFormData({ ...formData, attendees: remaining.join(", ") });
  };

  const addEditAttendeeEmail = (email) => {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) return;
    const current = String(editFormData.attendees || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (current.some((item) => item.toLowerCase() === normalizedEmail.toLowerCase())) return;
    setEditFormData({ ...editFormData, attendees: [...current, normalizedEmail].join(", ") });
  };

  const removeEditAttendeeEmail = (email) => {
    const remaining = String(editFormData.attendees || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && item.toLowerCase() !== String(email).toLowerCase());
    setEditFormData({ ...editFormData, attendees: remaining.join(", ") });
  };

  const handleCreateEvent = async (e) => {
    e?.preventDefault?.();
    const providerKey = createProvider || "google";
    if (!formData.title || !formData.startTime || !formData.endTime) {
      setToast("Title, start time, and end time are required");
      return;
    }
    if (!createStartTime || !createEndTime) {
      setToast("Please enter valid start and end times");
      return;
    }
    if (createEndIsInvalid) {
      setToast("End time must be after the start time");
      return;
    }
    if (createStartIsPast) {
      setToast("Start time must be now or in the future");
      return;
    }
    setBusy((b) => ({ ...b, [providerKey]: true }));
    try {
      const payload = {
        title: formData.title,
        description: formData.description,
        startTime: new Date(formData.startTime).toISOString(),
        endTime: new Date(formData.endTime).toISOString(),
        location: formData.location,
        attendees: formData.attendees
          ? formData.attendees.split(",").map((a) => a.trim())
          : [],
      };
      // Online meeting link is opt-in for both providers — Google Meet for
      // Google, Teams for Outlook. Both routes read the same createMeet flag.
      if (formData.createMeet) {
        payload.createMeet = true;
      }
      // Zoom is independent of the calendar provider — the backend creates the
      // Zoom meeting and weaves its join link into the event (no-op if Zoom
      // creds aren't configured server-side).
      if (formData.createZoom) {
        payload.createZoom = true;
      }
      await fetchApi(`/api/calendar/${providerKey}/events`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setToast(
        `Event created in ${providerKey === "google" ? "Google" : "Outlook"}`,
      );
      setShowCreateModal(false);
      setFormData({
        title: "",
        description: "",
        startTime: "",
        endTime: "",
        attendees: "",
        location: "",
        createMeet: false,
        createZoom: false,
      });
      setSlotPicker({ date: "", slots: [], loading: false, error: "" });
      await loadAll();
    } catch (e) {
      setToast(`Failed to create event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, [providerKey]: false }));
    }
  };

  // T18: fetch free/busy slots for the chosen day from the Google Calendar
  // slots endpoint. Each returned slot, when clicked, fills the start/end
  // datetime-local inputs (converted to the browser's local wall-clock so the
  // existing inputs render correctly). tzOffsetMins tells the backend which
  // wall-clock the working hours refer to.
  const handleFindSlots = async () => {
    if (!slotPicker.date) {
      setSlotPicker((s) => ({ ...s, error: "Pick a date first" }));
      return;
    }
    setSlotPicker((s) => ({ ...s, loading: true, error: "", slots: [] }));
    try {
      const tzOffsetMins = -new Date().getTimezoneOffset(); // e.g. +330 for IST
      const qs = new URLSearchParams({
        date: slotPicker.date,
        durationMins: "30",
        tzOffsetMins: String(tzOffsetMins),
      }).toString();
      const res = await fetchApi(`/api/calendar/${createProvider}/slots?${qs}`);
      const slots = Array.isArray(res?.slots) ? res.slots : [];
      const busyCount = Number(res?.busyCount || 0);
      setSlotPicker((s) => ({
        ...s,
        loading: false,
        slots,
        error: slots.length
          ? ""
          : busyCount > 0
            ? "No free slots between 9:00 AM and 6:00 PM. Your Google Calendar is busy during that window."
            : "No free slots between 9:00 AM and 6:00 PM.",
      }));
    } catch (err) {
      setSlotPicker((s) => ({
        ...s,
        loading: false,
        error: err.message || "Failed to load slots",
      }));
    }
  };

  // Convert an ISO instant to the value a datetime-local input expects
  // (local wall-clock, no timezone suffix, minute precision).
  const isoToLocalInput = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handlePickSlot = (slot) => {
    setFormData((f) => ({
      ...f,
      startTime: isoToLocalInput(slot.start),
      endTime: isoToLocalInput(slot.end),
    }));
  };

  const handleOpenEventDetail = (event) => {
    setSelectedEvent(event);
    setEditFormData({
      title: event.title,
      description: event.description || "",
      startTime: event.startTime
        ? new Date(event.startTime).toISOString().slice(0, 16)
        : "",
      endTime: event.endTime
        ? new Date(event.endTime).toISOString().slice(0, 16)
        : "",
      location: event.location || "",
      attendees: event.attendees
        ? typeof event.attendees === "string"
          ? JSON.parse(event.attendees)
              .map((a) => a.email || a)
              .join(", ")
          : event.attendees.join(", ")
        : "",
    });
    setShowEventDetail(true);
  };

  const handleEditEvent = async (e) => {
    e.preventDefault();
    if (getMeetingStatus(selectedEvent) === "in-progress") {
      setToast("In-progress meetings cannot be edited");
      setIsEditingEvent(false);
      return;
    }
    if (
      !editFormData.title ||
      !editFormData.startTime ||
      !editFormData.endTime
    ) {
      setToast("Title, start time, and end time are required");
      return;
    }
    setBusy((b) => ({ ...b, edit: true }));
    try {
      const payload = {
        title: editFormData.title,
        description: editFormData.description,
        startTime: new Date(editFormData.startTime).toISOString(),
        endTime: new Date(editFormData.endTime).toISOString(),
        location: editFormData.location,
        attendees: editFormData.attendees
          ? editFormData.attendees.split(",").map((a) => a.trim())
          : [],
      };
      await fetchApi(`/api/calendar/events/${selectedEvent.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setToast("Event updated successfully");
      setShowEventDetail(false);
      setIsEditingEvent(false);
      await loadAll();
    } catch (e) {
      setToast(`Failed to update event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, edit: false }));
    }
  };

  const handleDeleteEvent = async () => {
    if (
      !(await notify.confirm(
        "Are you sure you want to delete this event? This action cannot be undone.",
      ))
    )
      return;
    setBusy((b) => ({ ...b, delete: true }));
    try {
      await fetchApi(`/api/calendar/events/${selectedEvent.id}`, {
        method: "DELETE",
      });
      setToast("Event deleted successfully");
      setShowEventDetail(false);
      await loadAll();
    } catch (e) {
      setToast(`Failed to delete event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, delete: false }));
    }
  };

  const handleAddBirthday = async (e) => {
    e.preventDefault();
    if (birthdayForm.birthMonth === "" || birthdayForm.birthDay === "") {
      setBirthdayError("Pick a month and day");
      return;
    }
    const monthIndex = Number(birthdayForm.birthMonth);
    const day = Number(birthdayForm.birthDay);
    if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 12) {
      setBirthdayError("Pick a valid month");
      return;
    }
    const maxDays = getDaysInMonth(monthIndex);
    if (!Number.isInteger(day) || day < 1 || day > maxDays) {
      setBirthdayError(`Pick a valid day for ${BIRTHDAY_MONTHS[monthIndex]}`);
      return;
    }
    const birthDate = new Date(Date.UTC(BIRTHDAY_BASE_YEAR, monthIndex, day, 12, 0, 0));
    setBirthdaySaving(true);
    setBirthdayError("");
    try {
      const manualName = String(birthdayForm.manualName || "").trim();
      if (!manualName) {
        setBirthdayError("Enter a name for the birthday");
        return;
      }
      const manualEntry = {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source: "manual",
        name: manualName,
        manualName,
        birthMonth: String(monthIndex),
        birthDay: String(day),
        birthDate: birthDate.toISOString(),
        createdAt: new Date().toISOString(),
        linkedGoogleEventId: null,
      };
      setManualBirthdayEntries((prev) => [manualEntry, ...prev]);

      if (status.google.connected) {
        const normalizedName = normalizeBirthdayName(manualName);
        const targetMonthDay = `${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const existingGoogleBirthday = events.find((event) => {
          if (!isBirthdayLikeEvent(event)) return false;
          const eventName = normalizeBirthdayName(event?.title || "");
          if (eventName !== normalizedName) return false;
          return getBirthdayDateKey(event?.startTime || event?.start || event?.date) === targetMonthDay;
        });

        const existingGoogleId = existingGoogleBirthday?.id || existingGoogleBirthday?.externalId || null;
        if (existingGoogleId) {
          setManualBirthdayEntries((prev) =>
            prev.map((item) =>
              String(item.id) === String(manualEntry.id)
                ? { ...item, linkedGoogleEventId: String(existingGoogleId) }
                : item,
            ),
          );
        } else {
          const googlePayload = buildBirthdayCalendarPayload(manualName, birthDate);
          if (googlePayload) {
            try {
              const created = await fetchApi("/api/calendar/google/events", {
                method: "POST",
                body: JSON.stringify(googlePayload),
              });
              const createdId = created?.id || created?.externalId || null;
              if (createdId) {
                setEvents((prev) => [
                  {
                    ...created,
                    id: created.id ?? created.externalId ?? createdId,
                    _provider: "google",
                  },
                  ...prev.filter((item) => String(item.id) !== String(createdId)),
                ]);
                setManualBirthdayEntries((prev) =>
                  prev.map((item) =>
                    String(item.id) === String(manualEntry.id)
                      ? { ...item, linkedGoogleEventId: String(createdId) }
                      : item,
                  ),
                );
              }
            } catch (syncErr) {
              notify.info(
                syncErr?.body?.error || syncErr?.message || "Birthday saved locally, but Google Calendar sync failed",
              );
            }
          }
        }
      }

      notify.success("Birthday saved");
      setShowBirthdayModal(false);
      setBirthdayForm(createBirthdayDraft());
      await loadAll({ silent: true });
    } catch (err) {
      setBirthdayError(err?.body?.error || err?.message || "Could not save birthday");
    } finally {
      setBirthdaySaving(false);
    }
  };

  const handleDeleteBirthday = async (contact) => {
    if (contact?.source === "manual") {
      if (
        !(await notify.confirm(
          `Remove the birthday for ${contact?.name || "this person"}?`,
        ))
      ) {
        return;
      }
      if (contact?.linkedGoogleEventId) {
        try {
          await fetchApi(`/api/calendar/events/${contact.linkedGoogleEventId}`, {
            method: "DELETE",
          });
        } catch {
          // Best-effort cleanup only. We still remove the local birthday entry.
        }
      }
      setManualBirthdayEntries((prev) => prev.filter((item) => String(item.id) !== String(contact.id)));
      notify.success("Birthday removed");
      return;
    }

    if (contact?.source === "calendar" && contact?.birthdayEvent?.id) {
      if (
        !(await notify.confirm(
          `Remove the birthday for ${contact?.name || "this calendar entry"}?`,
        ))
      ) {
        return;
      }
      try {
        await fetchApi(`/api/calendar/events/${contact.birthdayEvent.id}`, {
          method: "DELETE",
        });
        setManualBirthdayEntries((prev) =>
          prev.filter(
            (item) => String(item.linkedGoogleEventId || "") !== String(contact.birthdayEvent.id),
          ),
        );
        setEvents((prev) =>
          prev.filter((item) => String(item.id) !== String(contact.birthdayEvent.id)),
        );
        notify.success("Birthday removed");
        await loadAll({ silent: true });
      } catch (err) {
        setToast(err?.body?.error || err?.message || "Could not remove birthday");
      }
      return;
    }

    if (
      !(await notify.confirm(
        `Remove the birthday for ${contact?.name || "this contact"}?`,
      ))
    ) {
      return;
    }
    try {
      await fetchApi(`/api/contacts/${contact.id}`, {
        method: "PUT",
        body: JSON.stringify({
          birthDate: null,
        }),
      });
      if (contact?.birthdayEvent?.id) {
        setManualBirthdayEntries((prev) =>
          prev.filter(
            (item) => String(item.linkedGoogleEventId || "") !== String(contact.birthdayEvent.id),
          ),
        );
      }
      setBirthdayContacts((prev) =>
        prev.filter((item) => String(item.id) !== String(contact.id)),
      );
      notify.success("Birthday removed");
      await loadAll({ silent: true });
    } catch (err) {
      setToast(err?.body?.error || err?.message || "Could not remove birthday");
    }
  };

  const summaryCards = [
    {
      key: "trips",
      label: "Confirmed trips",
      value: travelTripRows.length,
      hint: "All confirmed travel-brand trips",
      newCount: unreadAlerts.filter((alert) => alert.kind === "Trip").length,
    },
    {
      key: "birthdays",
      label: "Birthdays this month",
      value: birthdayRows.filter((contact) => {
        const nextBirthday = contact.nextBirthday;
        return nextBirthday && nextBirthday.getMonth() === new Date().getMonth();
      }).length,
      hint: "Month-wise birthday review",
      newCount: unreadAlerts.filter((alert) => alert.kind === "Birthday").length,
    },
    {
      key: "meetings",
      label: "Upcoming meetings",
      value: upcomingMeetingRows.length,
      hint: "Online + offline calendar items",
      newCount: unreadAlerts.filter((alert) => alert.kind === "Meeting").length,
    },
    {
      key: "alerts",
      label: "Pending alerts",
      value: visiblePendingAlerts.length,
      hint: "24h, 30m, and 10m reminders due",
      newCount: unreadAlerts.length,
    },
  ];

  const scrollToRef = (ref) => {
    if (!ref?.current) return;
    window.setTimeout(() => {
      ref.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  };

  const markAlertKeysSeen = (keys) => {
    const nextKeys = Array.isArray(keys) ? keys.filter(Boolean) : [];
    if (nextKeys.length === 0) return;
    setSeenAlertKeys((prev) => {
      let changed = false;
      const next = { ...prev };
      nextKeys.forEach((key) => {
        if (!next[key]) {
          next[key] = true;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  };

  const dismissAlertKeys = (keys) => {
    const nextKeys = Array.isArray(keys) ? keys.filter(Boolean) : [];
    if (nextKeys.length === 0) return;
    setDismissedAlertKeys((prev) => {
      let changed = false;
      const next = { ...prev };
      nextKeys.forEach((key) => {
        if (!next[key]) {
          next[key] = true;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  };

  const handleSummaryCardClick = (key) => {
    if (key === "trips") {
      setOpenPanel("details");
      setActiveTab("trips");
      scrollToRef(detailsSectionRef);
      return;
    }
    if (key === "birthdays") {
      setOpenPanel("details");
      setActiveTab("birthdays");
      scrollToRef(detailsSectionRef);
      return;
    }
    if (key === "meetings") {
      setOpenPanel("details");
      setActiveTab("meetings");
      scrollToRef(detailsSectionRef);
      return;
    }
    if (key === "alerts") {
      setOpenPanel("alerts");
      scrollToRef(alertsSectionRef);
    }
  };

  const handleAlertClick = (alert) => {
    markAlertKeysSeen([alert?.key]);
    if (alert?.trip) {
      openTripDetail(alert.trip);
      return;
    }
    if (alert?.event) {
      handleOpenEventDetail(alert.event);
      return;
    }
    if (alert?.contact) {
      setOpenPanel("details");
      setActiveTab("birthdays");
      scrollToRef(detailsSectionRef);
    }
  };

  const renderMeetingRows = (rows = []) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {rows.slice(0, CALENDAR_SYNC_MAX_RENDERED_MEETINGS).map((ev) => {
        const provider =
          PROVIDERS.find((p) => p.key === ev._provider) || PROVIDERS[0];
        const count = attendeeCount(ev.attendees);
        const meetingAlert = pendingAlerts.find(
          (alert) =>
            alert.kind === "Meeting" &&
            String(alert.event?.id) === String(ev.id) &&
            alert.event?._provider === ev._provider,
        );
        const alertKey = meetingAlert?.key;
        const isNew = Boolean(alertKey && unreadAlerts.some((alert) => alert.key === alertKey));
        const meetingStatus = getMeetingStatus(ev);
        const isInProgress = meetingStatus === "in-progress";
        return (
          <div
            key={`${ev._provider}-${ev.id}`}
            onClick={() => {
              markAlertKeysSeen([alertKey]);
              handleOpenEventDetail(ev);
            }}
            style={{
              display: "grid",
              gridTemplateColumns: "160px 1fr auto",
              gap: "1rem",
              alignItems: "center",
              padding: "0.75rem 1rem",
              borderRadius: "10px",
              background: CALENDAR_SYNC_ITEM_STYLE.background,
              border: CALENDAR_SYNC_ITEM_STYLE.border,
              cursor: "pointer",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-hover)";
              e.currentTarget.style.borderColor = "rgba(99,102,241,0.35)";
              e.currentTarget.style.transform = "translateX(2px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = CALENDAR_SYNC_ITEM_STYLE.background;
              e.currentTarget.style.borderColor = "var(--border-color)";
              e.currentTarget.style.transform = "translateX(0)";
            }}
          >
            <div
              style={{
                fontSize: "0.85rem",
                color: "var(--text-secondary)",
              }}
            >
              {formatDateTime(ev.startTime)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "0.95rem",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.45rem",
                }}
              >
                {ev.title}
                {isNew && (
                  <span
                    style={{
                      padding: "0.18rem 0.45rem",
                      borderRadius: 999,
                      background: "rgba(99,102,241,0.14)",
                      color: "var(--accent-color, #6366f1)",
                      fontSize: "0.65rem",
                      fontWeight: 800,
                    }}
                  >
                    New
                  </span>
                )}
                {isInProgress && (
                  <span
                    style={{
                      padding: "0.18rem 0.45rem",
                      borderRadius: 999,
                      background: "rgba(16,185,129,0.14)",
                      color: "#059669",
                      fontSize: "0.65rem",
                      fontWeight: 800,
                    }}
                  >
                    In progress
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                  marginTop: "0.15rem",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.25rem",
                    color: provider.color,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: provider.color,
                      display: "inline-block",
                    }}
                  />
                  {provider.label}
                </span>
                {count > 0 && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                    <Users size={12} /> {count}
                  </span>
                )}
                {ev.location && (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 200,
                    }}
                  >
                    {ev.location}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {ev.meetingUrl && (
                <a
                  href={ev.meetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    padding: "0.4rem 0.75rem",
                    borderRadius: "6px",
                    background: "rgba(99,102,241,0.12)",
                    color: "var(--accent-color, #6366f1)",
                    textDecoration: "none",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                  }}
                >
                  <Video size={13} /> Join
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderTripRows = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {travelTripRows.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
          No trips found yet.
        </div>
      ) : travelTripRows.map((trip) => {
        const alertKey = getTripAlertKey(trip);
        const isNew = Boolean(unreadAlerts.find((alert) => alert.key === alertKey));
        return (
        <div
          key={`${trip._source}-${trip.id}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            markAlertKeysSeen([alertKey]);
            openTripDetail(trip);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              markAlertKeysSeen([alertKey]);
              openTripDetail(trip);
            }
          }}
          style={{
            display: "grid",
            gridTemplateColumns: "140px 1fr auto",
            gap: "1rem",
            alignItems: "center",
            padding: "0.8rem 0.9rem",
            borderRadius: 10,
            background: CALENDAR_SYNC_ITEM_STYLE.background,
            cursor: "pointer",
            border: CALENDAR_SYNC_ITEM_STYLE.border,
          }}
        >
                      <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                        {trip._startDate ? formatShortDate(trip._startDate) : "—"}
                        <div style={{ marginTop: 4 }}>
                          {trip._endDate ? formatShortDate(trip._endDate) : "—"}
                        </div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", display: "flex", alignItems: "center", gap: "0.45rem" }}>
                          {trip._title}
                          {isNew && (
                            <span
                              style={{
                                padding: "0.18rem 0.45rem",
                                borderRadius: 999,
                                background: "rgba(99,102,241,0.14)",
                                color: "var(--accent-color, #6366f1)",
                                fontSize: "0.65rem",
                                fontWeight: 800,
                              }}
                            >
                              New
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: 4 }}>
                          Traveler: {trip._who}
                        </div>
                      </div>
                      <div
                        style={{
                          padding: "0.35rem 0.65rem",
                          borderRadius: 999,
                          background: "transparent",
                          color: "var(--accent-color, #6366f1)",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          textAlign: "center",
                        }}
                      >
                        <div>{trip._subBrandLabel}</div>
                        <div style={{ fontWeight: 500, fontSize: "0.68rem", opacity: 0.85, marginTop: 4 }}>
                        View details
                        </div>
                      </div>
                      <div style={{ gridColumn: "1 / -1", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        When: {trip._startDate ? formatShortDate(trip._startDate) : "—"}
                        {trip._endDate ? ` to ${formatShortDate(trip._endDate)}` : ""}
                      </div>
        </div>
        );
      })}
    </div>
  );

  const renderTripDetailModal = () => {
    if (!showTripDetail || !selectedTrip) return null;

    const totalPeople = selectedTripPeople.count;
    const detailTitle = selectedTrip._title || "Trip details";
    const detailSubtitle = selectedTrip._who || "Travel";
    const detailRecord = selectedTripDetail || selectedTrip;
    const detailContact = detailRecord?.contact || selectedTrip?.contact || {};
    const detailFields = [
      ["Destination", detailRecord?.destination || selectedTrip._title],
      ["Trip reference", detailRecord?.tripCode || detailRecord?.reference || detailRecord?.id],
      ["Primary traveler", detailContact?.name || selectedTrip._who],
      ["Email", detailContact?.email],
      ["Phone", detailContact?.phone],
      ["Passengers", detailRecord?.pax ?? detailRecord?.passengerCount],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");

    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trip details"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeTripDetail();
        }}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--overlay-bg, rgba(0,0,0,0.4))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9998,
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            background: CALENDAR_SYNC_DIALOG_STYLE.background,
            border: CALENDAR_SYNC_DIALOG_STYLE.border,
            borderRadius: "16px",
            boxShadow: CALENDAR_SYNC_DIALOG_STYLE.boxShadow,
            padding: "1.5rem",
            width: "min(760px, 100%)",
            maxHeight: "88vh",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "1rem",
              marginBottom: "1.25rem",
            }}
          >
            <div>
              <div style={{ fontSize: "1.35rem", fontWeight: 800, marginBottom: 4 }}>
                {detailTitle}
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.92rem" }}>
                {detailSubtitle}
              </div>
            </div>
            <button
              onClick={closeTripDetail}
              style={{
                background: "none",
                border: "none",
                fontSize: "1.5rem",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "0",
              }}
              aria-label="Close trip details"
            >
              ×
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.75rem",
              marginBottom: "1.25rem",
            }}
          >
            <div style={{ borderRadius: 10, padding: "0.9rem", ...CALENDAR_SYNC_ITEM_STYLE }}>
              <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 4 }}>When</div>
              <div style={{ fontWeight: 700 }}>
                {selectedTrip._startDate ? formatShortDate(selectedTrip._startDate) : "—"}
                {selectedTrip._endDate ? ` to ${formatShortDate(selectedTrip._endDate)}` : ""}
              </div>
            </div>
            <div style={{ borderRadius: 10, padding: "0.9rem", ...CALENDAR_SYNC_ITEM_STYLE }}>
              <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 4 }}>Persons</div>
              <div style={{ fontWeight: 800, fontSize: "1.1rem" }}>
                {tripDetailLoading ? "Loading..." : `${totalPeople} person${totalPeople === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>

          {tripDetailError && (
            <div
              style={{
                borderRadius: 10,
                padding: "0.85rem 1rem",
                marginBottom: "1rem",
                background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.25)",
                color: "#dc2626",
                fontSize: "0.9rem",
              }}
            >
              {tripDetailError}
            </div>
          )}

          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ fontWeight: 800, marginBottom: "0.75rem" }}>Trip details</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "0.75rem",
              }}
            >
              {detailFields.map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    borderRadius: 10,
                    background: "var(--surface-hover)",
                    border: "1px solid var(--border-color)",
                    padding: "0.9rem",
                  }}
                >
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{String(value)}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontWeight: 800, marginBottom: "0.75rem" }}>Person details</div>
            {tripDetailLoading ? (
              <div style={{ color: "var(--text-secondary)", padding: "0.5rem 0" }}>
                Loading trip details...
              </div>
            ) : selectedTripPeople.people.length === 0 ? (
              <div style={{ color: "var(--text-secondary)", padding: "0.5rem 0" }}>
                No person details were returned for this trip.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {selectedTripPeople.people.map((person) => (
                  <div
                    key={`${selectedTrip._source}-${selectedTrip.id}-${person.id}`}
                    style={{
                      borderRadius: 10,
                      background: "var(--surface-hover)",
                      border: "1px solid var(--border-color)",
                      padding: "0.9rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{person.name}</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: 4 }}>
                          {person.role}
                          {person.email ? ` · ${person.email}` : ""}
                          {person.phone ? ` · ${person.phone}` : ""}
                        </div>
                      </div>
                      <div
                        style={{
                          padding: "0.3rem 0.6rem",
                          borderRadius: 999,
                          background: "rgba(99,102,241,0.12)",
                          color: "var(--accent-color, #6366f1)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {person.status}
                      </div>
                    </div>
                    {(person.parentName || person.parentPhone || person.consent || person.note) && (
                      <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                        {person.parentName ? <div>Parent: {person.parentName}</div> : null}
                        {person.parentPhone ? <div>Parent phone: {person.parentPhone}</div> : null}
                        {person.consent ? <div>{person.consent}</div> : null}
                        {person.note ? <div>{person.note}</div> : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedTrip._source === "itinerary" && (
            <div
              style={{
                marginBottom: "1rem",
                borderRadius: 10,
                background: "var(--surface-hover)",
                border: "1px solid var(--border-color)",
                padding: "0.9rem",
                color: "var(--text-secondary)",
                fontSize: "0.9rem",
                lineHeight: 1.5,
              }}
            >
              Itineraries show the primary contact and passenger count here. If additional passenger names are stored elsewhere in the trip record, they are not exposed by the current detail payload.
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  };

  const renderBirthdayRows = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {birthdayGroups.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
          No birthdays found in the current contact list.
        </div>
      ) : birthdayGroups.map(([label, contacts]) => (
        <div
          key={label}
          style={{
            borderRadius: 12,
            border: CALENDAR_SYNC_ITEM_STYLE.border,
            background: CALENDAR_SYNC_ITEM_STYLE.background,
            padding: "1rem",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: "0.85rem" }}>{label}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {contacts.map((contact) => {
              const isSoon = contact.nextBirthday && (contact.nextBirthday.getTime() - Date.now()) <= 24 * 60 * 60 * 1000;
              const alertKey = getBirthdayAlertKey(contact);
              const isNew = Boolean(unreadAlerts.find((alert) => alert.key === alertKey));
              return (
                <div
                  key={contact.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1rem",
                    alignItems: "center",
                    padding: "0.7rem 0.85rem",
                    borderRadius: 10,
                    background: CALENDAR_SYNC_ITEM_STYLE.background,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: "0.45rem" }}>
                      {contact.name || "Birthday"}
                      {contact.source === "calendar" && (
                        <span
                          style={{
                            padding: "0.16rem 0.42rem",
                            borderRadius: 999,
                            background: "rgba(14,165,233,0.14)",
                            color: "#38bdf8",
                            fontSize: "0.62rem",
                            fontWeight: 800,
                          }}
                        >
                          {contact.sourceLabel || "Birthday"}
                        </span>
                      )}
                      {isNew && (
                        <span
                          style={{
                            padding: "0.18rem 0.45rem",
                            borderRadius: 999,
                            background: "rgba(99,102,241,0.14)",
                            color: "var(--accent-color, #6366f1)",
                            fontSize: "0.65rem",
                            fontWeight: 800,
                          }}
                        >
                          New
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                      {contact.source === "manual"
                        ? `${formatShortDate(contact.birthDateObj)}`
                        : `${contact.birthDateObj ? formatShortDate(contact.birthDateObj) : "Birthday on file"}`}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
                    {isSoon && (
                      <div
                        style={{
                          padding: "0.3rem 0.6rem",
                          borderRadius: 999,
                          background: "rgba(245,158,11,0.14)",
                          color: "#f59e0b",
                          fontSize: "0.74rem",
                          fontWeight: 700,
                        }}
                        >
                          24h alert
                        </div>
                    )}
                    {contact.canDelete && (
                      <button
                        type="button"
                        onClick={() => handleDeleteBirthday(contact)}
                        title="Delete birthday"
                        aria-label={`Delete birthday for ${contact.name || "contact"}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 34,
                          height: 34,
                          borderRadius: 999,
                          border: "1px solid rgba(239,68,68,0.35)",
                          background: "rgba(239,68,68,0.1)",
                          color: "#ef4444",
                          cursor: "pointer",
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ padding: "2rem", animation: "fadeIn 0.3s ease" }}>
      {toast && <Toast msg={toast} onClose={() => setToast("")} />}

      <header
        style={{
          marginBottom: "2rem",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <Calendar size={26} style={{ color: "var(--accent-color)" }} />
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", margin: 0 }}>
            Calendar Sync
          </h2>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
              margin: 0,
            }}
          >
            {tenantVertical === "travel"
              ? "Connect your Google Calendar to sync meetings into the CRM"
              : "Connect your Google and Outlook calendars to sync meetings into the CRM"}
          </p>
        </div>
      </header>

      {/* Provider cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.25rem",
          marginBottom: "2rem",
        }}
      >
        {availableProviders.map((p) => {
          const s = status[p.key];
          return (
            <div
              key={p.key}
              className="card"
              style={{
                padding: "1.5rem",
                borderRadius: "14px",
                background: CALENDAR_SYNC_CARD_STYLE.background,
                border: CALENDAR_SYNC_CARD_STYLE.border,
                boxShadow: CALENDAR_SYNC_CARD_STYLE.boxShadow,
                backdropFilter: CALENDAR_SYNC_CARD_STYLE.backdropFilter,
              }}
            >
              {/* Header with provider info and Create Event button */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.85rem",
                  marginBottom: "1rem",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.85rem",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "10px",
                      background: p.bg,
                      color: p.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                      fontSize: "1.1rem",
                    }}
                  >
                    {p.initials}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "1rem" }}>
                      {p.label}
                    </div>
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: s.connected
                          ? "#22c55e"
                          : "var(--text-secondary)",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.25rem",
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: s.connected ? "#22c55e" : "#94a3b8",
                          display: "inline-block",
                        }}
                      />
                      {s.connected ? "Connected" : "Not connected"}
                    </div>
                  </div>
                </div>

                {/* Create Event button (top right) */}
                {s.connected && (
                  <button
                    onClick={() => {
                      setCreateProvider(p.key);
                      setShowCreateModal(true);
                    }}
                    disabled={busy[p.key]}
                    title="Create new calendar event"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "8px",
                      border: "none",
                      background: "rgba(99,102,241,0.15)",
                      color: "var(--accent-color, #6366f1)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: busy[p.key] ? 0.6 : 1,
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "rgba(99,102,241,0.25)";
                      e.currentTarget.style.transform = "scale(1.05)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(99,102,241,0.15)";
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                  >
                    <Plus size={20} />
                  </button>
                )}
              </div>

              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  marginBottom: "1rem",
                  minHeight: "1.25rem",
                }}
              >
                {s.lastSyncAt
                  ? `Last activity: ${formatDateTime(s.lastSyncAt)}`
                  : s.connected
                    ? "No sync yet"
                    : "Connect to start syncing meetings"}
              </div>

              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {!s.connected ? (
                  <button
                    onClick={() => handleConnect(p.key)}
                    disabled={busy[p.key]}
                    style={{
                      padding: "0.55rem 1rem",
                      borderRadius: "8px",
                      border: "none",
                      background: p.color,
                      color: "#fff",
                      cursor: "pointer",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      opacity: busy[p.key] ? 0.7 : 1,
                    }}
                  >
                    <Plug size={15} />{" "}
                    {busy[p.key] ? "Connecting..." : "Connect"}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => handleSync(p.key)}
                      disabled={busy[p.key]}
                      style={{
                        padding: "0.55rem 1rem",
                        borderRadius: "8px",
                        border: "none",
                        background: "var(--accent-color, #6366f1)",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: "0.85rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        opacity: busy[p.key] ? 0.7 : 1,
                      }}
                    >
                      <RefreshCw
                        size={15}
                        className={busy[p.key] ? "spin" : ""}
                      />
                      {busy[p.key] ? "Syncing..." : "Sync Now"}
                    </button>
                    <button
                      onClick={() => handleDisconnect(p.key)}
                      disabled={busy[p.key]}
                      style={{
                        padding: "0.55rem 1rem",
                        borderRadius: "8px",
                        border: "1px solid rgba(239,68,68,0.4)",
                        background: "transparent",
                        color: "#ef4444",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: "0.85rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                      }}
                    >
                      <Trash2 size={15} /> Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1rem" }}>
        {summaryCards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => handleSummaryCardClick(card.key)}
            style={{
              textAlign: "left",
              padding: "1rem",
              borderRadius: 14,
              background: "var(--surface-color)",
              border: "1px solid var(--border-color)",
              cursor: "pointer",
              transition: "transform 0.2s ease, border-color 0.2s ease, background 0.2s ease",
              position: "relative",
              boxShadow: "0 12px 28px rgba(0,0,0,0.10)",
              color: "var(--text-primary)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.borderColor = "rgba(99,102,241,0.35)";
              e.currentTarget.style.background = "var(--surface-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.borderColor = "var(--border-color)";
              e.currentTarget.style.background = "var(--surface-color)";
            }}
          >
            {card.newCount > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  padding: "0.22rem 0.5rem",
                  borderRadius: 999,
                  background: "rgba(99,102,241,0.14)",
                  color: "var(--accent-color, #6366f1)",
                  fontSize: "0.68rem",
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                }}
              >
                New {card.newCount}
              </div>
            )}
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{card.label}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 800, marginTop: 4 }}>{card.value}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginTop: 4 }}>{card.hint}</div>
          </button>
        ))}
      </div>

      {openPanel === "alerts" && sortedPendingAlerts.length > 0 && (
        <div
          className="card"
          ref={alertsSectionRef}
          style={{
            padding: "1rem 1.25rem",
            background: "var(--surface-color)",
            border: "1px solid rgba(245,158,11,0.24)",
            borderRadius: "14px",
            marginBottom: "1rem",
            boxShadow: "0 16px 40px rgba(0,0,0,0.10)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ fontWeight: 700 }}>Pending alerts</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>24h trip/birthday reminders plus 24h, 30m, and 10m meeting reminders</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {sortedPendingAlerts.map((alert) => (
              <div
                key={alert.key}
                role="button"
                tabIndex={0}
                onClick={() => handleAlertClick(alert)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleAlertClick(alert);
                  }
                }}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  alignItems: "center",
                  padding: "0.65rem 0.8rem",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.04)",
                  cursor: "pointer",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: "0.45rem" }}>
                    {alert.kind}: {alert.title}
                    {Boolean(unreadAlerts.find((item) => item.key === alert.key)) && (
                      <span
                        style={{
                          padding: "0.18rem 0.45rem",
                          borderRadius: 999,
                          background: "rgba(99,102,241,0.14)",
                          color: "var(--accent-color, #6366f1)",
                          fontSize: "0.65rem",
                          fontWeight: 800,
                        }}
                      >
                        New
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    {formatDateTime(getAlertNotificationTime(alert))} · {alert.note}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.2rem", minWidth: 92 }}>
                  <div style={{ fontSize: "0.74rem", fontWeight: 700, color: "#f59e0b" }}>Due soon</div>
                    {(alert.trip || alert.event || alert.contact) && (
                      <div style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--accent-color, #6366f1)" }}>
                        View details
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissAlertKeys([alert.key]);
                    }}
                    title="Remove alert"
                    aria-label={`Remove ${alert.kind.toLowerCase()} alert: ${alert.title}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 999,
                      border: "1px solid rgba(239,68,68,0.28)",
                      background: "rgba(239,68,68,0.08)",
                      color: "#ef4444",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {openPanel === "details" && (
        <div
          className="card"
          ref={detailsSectionRef}
          style={{
            padding: "1.5rem",
            borderRadius: "14px",
            background: CALENDAR_SYNC_CARD_STYLE.background,
            border: CALENDAR_SYNC_CARD_STYLE.border,
            boxShadow: CALENDAR_SYNC_CARD_STYLE.boxShadow,
            backdropFilter: CALENDAR_SYNC_CARD_STYLE.backdropFilter,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>
                {activeTab === "trips"
                  ? "Travel trips"
                  : activeTab === "birthdays"
                    ? "Birthdays"
                    : meetingStatusFilter === "completed"
                      ? "Completed meetings"
                      : "Upcoming meetings"}
              </h3>
              <div style={{ marginTop: 4, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {activeTab === "trips"
                  ? `${travelTripRows.length} confirmed trip${travelTripRows.length === 1 ? "" : "s"}`
                  : activeTab === "birthdays"
                    ? `${filteredBirthdayRows.length} contact birthday${filteredBirthdayRows.length === 1 ? "" : "s"} · ${selectedBirthdayMonthLabel}`
                    : `${filteredMeetingRows.length} event${filteredMeetingRows.length === 1 ? "" : "s"} · ${
                        meetingStatusFilter === "completed" ? "Completed" : "Upcoming"
                      }`}
              </div>
            </div>
            {activeTab === "birthdays" && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontWeight: 600 }}>Month</span>
                  <select
                    value={birthdayMonthFilter || "all"}
                    onChange={(e) => setBirthdayMonthFilter(e.target.value)}
                    style={{
                      minWidth: 180,
                      padding: "0.7rem 0.9rem",
                      borderRadius: 999,
                      border: "1px solid rgba(99,102,241,0.28)",
                      background: "rgba(99,102,241,0.08)",
                      color: "var(--text-primary)",
                      outline: "none",
                      fontWeight: 600,
                    }}
                  >
                    <option value="all">All months</option>
                    {birthdayMonthOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label || "Current month"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setBirthdayError("");
                    setBirthdayForm(createBirthdayDraft());
                    setShowBirthdayModal(true);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    padding: "0.7rem 0.95rem",
                    borderRadius: 999,
                    border: "1px solid rgba(99,102,241,0.35)",
                    background: "rgba(99,102,241,0.12)",
                    color: "var(--accent-color, #6366f1)",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  <Plus size={15} />
                  Add birthday
                </button>
              </div>
            )}
            {activeTab === "meetings" && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontWeight: 600 }}>Status</span>
                  <select
                    value={meetingStatusFilter}
                    onChange={(e) => setMeetingStatusFilter(e.target.value)}
                    style={{
                      minWidth: 160,
                      padding: "0.7rem 0.9rem",
                      borderRadius: 999,
                      border: "1px solid rgba(99,102,241,0.28)",
                      background: "rgba(99,102,241,0.08)",
                      color: "var(--text-primary)",
                      outline: "none",
                      fontWeight: 600,
                    }}
                  >
                    <option value="upcoming">Upcoming</option>
                    <option value="completed">Completed</option>
                  </select>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontWeight: 600 }}>Date</span>
                  <input
                    type="date"
                    value={meetingDateFilter}
                    onClick={openNativePicker}
                    onKeyDown={blockManualDateEntry}
                    onChange={(e) => setMeetingDateFilter(e.target.value)}
                    style={{
                      minWidth: 170,
                      padding: "0.7rem 0.9rem",
                      borderRadius: 999,
                      border: "1px solid rgba(99,102,241,0.28)",
                      background: "rgba(99,102,241,0.08)",
                      color: "var(--text-primary)",
                      outline: "none",
                      fontWeight: 600,
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMeetingStatusFilter("upcoming");
                    setMeetingDateFilter("");
                  }}
                  style={{
                    padding: "0.7rem 0.95rem",
                    borderRadius: 999,
                    border: "1px solid rgba(99,102,241,0.28)",
                    background: "transparent",
                    color: "var(--text-primary)",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
              Loading events...
            </div>
          ) : activeTab === "trips" ? (
            travelTripRows.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
                No travel trips found yet.
              </div>
            ) : (
              renderTripRows()
            )
          ) : activeTab === "birthdays" ? (
            filteredBirthdayRows.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
                {birthdayRows.length === 0
                  ? "No birthdays found yet. Add a contact birthday or create a manual birthday to surface it here."
                  : `No birthdays found for ${selectedBirthdayMonthLabel.toLowerCase()}.`}
              </div>
            ) : (
              renderBirthdayRows()
            )
          ) : meetingRows.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
              No events synced yet. Connect a calendar above and click "Sync Now".
            </div>
          ) : filteredMeetingRows.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
              No meetings found for the selected filters.
            </div>
          ) : (
            renderMeetingRows(filteredMeetingRows)
          )}
        </div>
      )}

      {renderTripDetailModal()}

      {showBirthdayModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add birthday"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setShowBirthdayModal(false);
              setBirthdayError("");
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1.5rem",
          }}
        >
          <div
            className="card"
            style={{
              width: "min(520px, 100%)",
              padding: "1.5rem",
              background: CALENDAR_SYNC_CARD_STYLE.background,
              border: CALENDAR_SYNC_CARD_STYLE.border,
              borderRadius: "16px",
              boxShadow: "0 24px 60px rgba(0,0,0,0.28)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "1.2rem" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>Add birthday</h3>
                <div style={{ marginTop: 4, fontSize: "0.84rem", color: "var(--text-secondary)" }}>
                  Add a manual birthday for a staff member, supplier, VIP, or other person.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBirthdayModal(false);
                  setBirthdayError("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 0,
                }}
                aria-label="Close birthday dialog"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddBirthday} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 700 }}>Name</span>
                <input
                  type="text"
                  value={birthdayForm.manualName}
                  onChange={(e) => setBirthdayForm((prev) => ({ ...prev, manualName: e.target.value }))}
                  className="input-field"
                  placeholder="Enter name"
                  style={{ width: "100%" }}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 700 }}>Month</span>
                  <select
                    value={birthdayForm.birthMonth}
                    onChange={(e) => {
                      const nextMonth = e.target.value;
                      setBirthdayForm((prev) => {
                        const currentDay = Number(prev.birthDay);
                        const maxDays = nextMonth === "" ? 0 : getDaysInMonth(Number(nextMonth));
                        return {
                          ...prev,
                          birthMonth: nextMonth,
                          birthDay: currentDay > maxDays ? "" : prev.birthDay,
                        };
                      });
                    }}
                    className="input-field"
                    style={{ width: "100%" }}
                  >
                    <option value="">Select month</option>
                    {BIRTHDAY_MONTHS.map((label, index) => (
                      <option key={label} value={String(index)}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 700 }}>Day</span>
                  <select
                    value={birthdayForm.birthDay}
                    onChange={(e) => setBirthdayForm((prev) => ({ ...prev, birthDay: e.target.value }))}
                    className="input-field"
                    style={{ width: "100%" }}
                    disabled={birthdayForm.birthMonth === ""}
                  >
                    <option value="">Select day</option>
                    {birthdayForm.birthMonth !== "" &&
                      Array.from(
                        { length: getDaysInMonth(Number(birthdayForm.birthMonth)) },
                        (_, index) => index + 1,
                      ).map((day) => (
                        <option key={day} value={String(day)}>
                          {day}
                        </option>
                      ))}
                  </select>
                </label>
              </div>

              {birthdayError && (
                <div style={{ color: "#ef4444", fontSize: "0.82rem" }}>
                  {birthdayError}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.25rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowBirthdayModal(false);
                    setBirthdayError("");
                  }}
                  style={{
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "none",
                    cursor: "pointer",
                    padding: "0.75rem 1rem",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={birthdaySaving}
                  className="btn-primary"
                >
                  {birthdaySaving ? "Saving..." : "Save birthday"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Event Detail Modal */}
      {showEventDetail && selectedEvent && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--overlay-bg, rgba(0,0,0,0.4))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9998,
          }}
        >
        <div
          style={{
            background: CALENDAR_SYNC_DIALOG_STYLE.background,
            border: CALENDAR_SYNC_DIALOG_STYLE.border,
            borderRadius: "12px",
            boxShadow: CALENDAR_SYNC_DIALOG_STYLE.boxShadow,
            padding: "2rem",
            maxWidth: "550px",
            width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
            }}
          >
            {!isEditingEvent ? (
              <>
                {/* View Mode */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "1.5rem",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "1.3rem",
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    {selectedEvent.title}
                  </h3>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "1.5rem",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      padding: "0",
                      transition: "color 0.2s ease",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = "var(--text-primary)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.color = "var(--text-secondary)")
                    }
                  >
                    ✕
                  </button>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "1.5rem",
                  }}
                >
                  {/* Date & Time */}
                  <div
                    style={{
                      borderLeft: "3px solid #6366f1",
                      paddingLeft: "1rem",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-secondary)",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        marginBottom: "0.5rem",
                      }}
                    >
                      Date & Time
                    </div>
                    <div
                      style={{
                        fontSize: "0.95rem",
                        color: "var(--text-primary)",
                        fontWeight: 500,
                      }}
                    >
                      {formatDateTime(selectedEvent.startTime)} -{" "}
                      {new Date(selectedEvent.endTime).toLocaleTimeString(
                        undefined,
                        { hour: "2-digit", minute: "2-digit" },
                      )}
                    </div>
                  </div>

                  {/* Location */}
                  {selectedEvent.location && (
                    <div
                      style={{
                        borderLeft: "3px solid #10b981",
                        paddingLeft: "1rem",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          marginBottom: "0.5rem",
                        }}
                      >
                        Location
                      </div>
                      <div
                        style={{
                          fontSize: "0.95rem",
                          color: "var(--text-primary)",
                          fontWeight: 500,
                        }}
                      >
                        {selectedEvent.location}
                      </div>
                    </div>
                  )}

                  {/* Attendees */}
                  {attendeeCount(selectedEvent.attendees) > 0 && (
                    <div
                      style={{
                        borderLeft: "3px solid #f59e0b",
                        paddingLeft: "1rem",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          marginBottom: "0.5rem",
                        }}
                      >
                        Attendees
                      </div>
                      <div
                        style={{
                          fontSize: "0.9rem",
                          color: "var(--text-primary)",
                        }}
                      >
                        {(() => {
                          try {
                            const att =
                              typeof selectedEvent.attendees === "string"
                                ? JSON.parse(selectedEvent.attendees)
                                : selectedEvent.attendees;
                            return Array.isArray(att)
                              ? att.map((a, i) => (
                                  <div
                                    key={i}
                                    style={{ marginBottom: "0.25rem" }}
                                  >
                                    • {a.email || a.name || a}
                                  </div>
                                ))
                              : null;
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Description */}
                  {selectedEvent.description && (
                    <div
                      style={{
                        borderLeft: "3px solid #8b5cf6",
                        paddingLeft: "1rem",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          marginBottom: "0.5rem",
                        }}
                      >
                        Description
                      </div>
                      <div
                        style={{
                          fontSize: "0.9rem",
                          color: "var(--text-primary)",
                          lineHeight: "1.5",
                        }}
                      >
                        {selectedEvent.description}
                      </div>
                    </div>
                  )}

                  {/* Provider Badge */}
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.5rem 1rem",
                      borderRadius: "8px",
                      background: `${PROVIDERS.find((p) => p.key === selectedEvent._provider)?.bg || "rgba(99,102,241,0.1)"}`,
                      width: "fit-content",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background:
                          PROVIDERS.find(
                            (p) => p.key === selectedEvent._provider,
                          )?.color || "#6366f1",
                        display: "inline-block",
                      }}
                    />
                    <span
                      style={{
                        color:
                          PROVIDERS.find(
                            (p) => p.key === selectedEvent._provider,
                          )?.color || "#6366f1",
                        fontSize: "0.85rem",
                        fontWeight: 600,
                      }}
                    >
                      {PROVIDERS.find((p) => p.key === selectedEvent._provider)
                        ?.label || "Calendar"}
                    </span>
                  </div>
                </div>

                {/* Buttons */}
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    marginTop: "2rem",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      padding: "0.65rem 1.5rem",
                      borderRadius: "8px",
                      border: "1px solid var(--border-color)",
                      background: "var(--bg-color)",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--input-bg)";
                      e.currentTarget.style.borderColor = "var(--border-color)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "var(--input-bg-focus)";
                      e.currentTarget.style.borderColor = "var(--border-color)";
                    }}
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      if (getMeetingStatus(selectedEvent) === "in-progress") {
                        setToast("In-progress meetings cannot be edited");
                        return;
                      }
                      setIsEditingEvent(true);
                    }}
                    disabled={getMeetingStatus(selectedEvent) === "in-progress"}
                    title={
                      getMeetingStatus(selectedEvent) === "in-progress"
                        ? "In-progress meetings cannot be edited"
                        : "Edit event"
                    }
                    style={{
                      padding: "0.65rem 1.5rem",
                      borderRadius: "8px",
                      border: "none",
                      background: "var(--accent-color, #6366f1)",
                      color: "#fff",
                      cursor:
                        getMeetingStatus(selectedEvent) === "in-progress"
                          ? "not-allowed"
                          : "pointer",
                      opacity: getMeetingStatus(selectedEvent) === "in-progress" ? 0.5 : 1,
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "var(--accent-hover, #4f46e5)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "var(--accent-color, #6366f1)";
                    }}
                  >
                    ✎ Edit
                  </button>
                  <button
                    onClick={handleDeleteEvent}
                    disabled={busy.delete}
                    style={{
                      padding: "0.65rem 1.5rem",
                      borderRadius: "8px",
                      border: "1px solid rgba(239,68,68,0.3)",
                      background: "rgba(239,68,68,0.12)",
                      color: "#dc2626",
                      cursor: busy.delete ? "not-allowed" : "pointer",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      opacity: busy.delete ? 0.6 : 1,
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      if (!busy.delete) {
                        e.currentTarget.style.background =
                          "rgba(239,68,68,0.18)";
                        e.currentTarget.style.borderColor =
                          "rgba(239,68,68,0.4)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(239,68,68,0.12)";
                      e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)";
                    }}
                  >
                    {busy.delete ? "🗑️ Deleting..." : "🗑️ Delete"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Edit Mode */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "1.5rem",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "1.3rem",
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Edit Event
                  </h3>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "1.5rem",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      padding: "0",
                      transition: "color 0.2s ease",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = "var(--text-primary)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.color = "var(--text-secondary)")
                    }
                  >
                    ✕
                  </button>
                </div>

                <form
                  onSubmit={handleEditEvent}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "1.25rem",
                  }}
                >
                  {/* Title */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        marginBottom: "0.6rem",
                        color: "var(--text-primary)",
                        letterSpacing: "0.3px",
                      }}
                    >
                      Event Title <span style={{ color: "#ef4444" }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={editFormData.title}
                      onChange={(e) =>
                        setEditFormData({
                          ...editFormData,
                          title: e.target.value,
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "0.85rem",
                        fontSize: "0.95rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        background: "var(--input-bg)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                        transition: "all 0.2s ease",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor =
                          "var(--accent-color, #6366f1)";
                        e.target.style.background = "var(--input-bg-focus)";
                        e.target.style.boxShadow =
                          "0 0 0 3px rgba(99,102,241,0.1)";
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "var(--border-color)";
                        e.target.style.background = "var(--input-bg)";
                        e.target.style.boxShadow = "none";
                      }}
                    />
                  </div>

                  {/* Start and End Time */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "0.85rem",
                          fontWeight: 700,
                          marginBottom: "0.6rem",
                          color: "var(--text-primary)",
                          letterSpacing: "0.3px",
                        }}
                      >
                        Start Time <span style={{ color: "#ef4444" }}>*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={editFormData.startTime}
                        onChange={(e) =>
                          setEditFormData({
                            ...editFormData,
                            startTime: e.target.value,
                          })
                        }
                        style={{
                          width: "100%",
                          padding: "0.85rem",
                          fontSize: "0.92rem",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--input-bg)",
                          color: "var(--text-primary)",
                          boxSizing: "border-box",
                          transition: "all 0.2s ease",
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor =
                            "var(--accent-color, #6366f1)";
                          e.target.style.background = "var(--input-bg-focus)";
                          e.target.style.boxShadow =
                            "0 0 0 3px rgba(99,102,241,0.1)";
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = "var(--border-color)";
                          e.target.style.background = "var(--input-bg)";
                          e.target.style.boxShadow = "none";
                        }}
                      />
                    </div>

                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "0.85rem",
                          fontWeight: 700,
                          marginBottom: "0.6rem",
                          color: "var(--text-primary)",
                          letterSpacing: "0.3px",
                        }}
                      >
                        End Time <span style={{ color: "#ef4444" }}>*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={editFormData.endTime}
                        onChange={(e) =>
                          setEditFormData({
                            ...editFormData,
                            endTime: e.target.value,
                          })
                        }
                        style={{
                          width: "100%",
                          padding: "0.85rem",
                          fontSize: "0.92rem",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--input-bg)",
                          color: "var(--text-primary)",
                          boxSizing: "border-box",
                          transition: "all 0.2s ease",
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor =
                            "var(--accent-color, #6366f1)";
                          e.target.style.background = "var(--input-bg-focus)";
                          e.target.style.boxShadow =
                            "0 0 0 3px rgba(99,102,241,0.1)";
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = "var(--border-color)";
                          e.target.style.background = "var(--input-bg)";
                          e.target.style.boxShadow = "none";
                        }}
                      />
                    </div>
                  </div>

                  {/* Location */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        marginBottom: "0.6rem",
                        color: "var(--text-primary)",
                        letterSpacing: "0.3px",
                      }}
                    >
                      Location
                    </label>
                    <input
                      type="text"
                      value={editFormData.location}
                      onChange={(e) =>
                        setEditFormData({
                          ...editFormData,
                          location: e.target.value,
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "0.85rem",
                        fontSize: "0.95rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        background: "var(--input-bg)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                        transition: "all 0.2s ease",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor =
                          "var(--accent-color, #6366f1)";
                        e.target.style.background = "var(--input-bg-focus)";
                        e.target.style.boxShadow =
                          "0 0 0 3px rgba(99,102,241,0.1)";
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "var(--border-color)";
                        e.target.style.background = "var(--input-bg)";
                        e.target.style.boxShadow = "none";
                      }}
                    />
                  </div>

                  {/* Attendees */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        marginBottom: "0.6rem",
                        color: "var(--text-primary)",
                        letterSpacing: "0.3px",
                      }}
                    >
                      Attendees
                    </label>
                    {contactOptions.length > 0 && (
                      <select
                        value=""
                        aria-label="Add attendee from contacts"
                        onChange={(e) => {
                          addEditAttendeeEmail(e.target.value);
                          e.target.value = "";
                        }}
                        style={{
                          width: "100%",
                          padding: "0.7rem",
                          fontSize: "0.9rem",
                          marginBottom: "0.5rem",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--bg-color)",
                          color: "var(--text-primary)",
                          boxSizing: "border-box",
                          cursor: "pointer",
                        }}
                      >
                        <option value="">+ Add from contacts…</option>
                        {contactOptions.map((contact) => (
                          <option key={contact.email} value={contact.email}>
                            {contact.name} ({contact.email})
                          </option>
                        ))}
                      </select>
                    )}
                    {editFormData.attendees && (
                      <div
                        aria-label="Selected attendees"
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.45rem",
                          marginBottom: "0.5rem",
                          padding: "0.65rem",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--bg-color)",
                        }}
                      >
                        {editFormData.attendees
                          .split(",")
                          .map((email) => email.trim())
                          .filter(Boolean)
                          .map((email) => (
                            <span
                              key={email.toLowerCase()}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.35rem",
                                maxWidth: "100%",
                                padding: "0.35rem 0.55rem",
                                borderRadius: "999px",
                                background: "rgba(99,102,241,0.12)",
                                color: "var(--text-primary)",
                                fontSize: "0.82rem",
                              }}
                            >
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {email}
                              </span>
                              <button
                                type="button"
                                aria-label={`Remove ${email}`}
                                title={`Remove ${email}`}
                                onClick={() => removeEditAttendeeEmail(email)}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 0,
                                  border: 0,
                                  background: "transparent",
                                  color: "inherit",
                                  cursor: "pointer",
                                }}
                              >
                                <X size={14} />
                              </button>
                            </span>
                          ))}
                      </div>
                    )}
                    <input
                      type="text"
                      value={editFormData.attendees}
                      onChange={(e) =>
                        setEditFormData({
                          ...editFormData,
                          attendees: e.target.value,
                        })
                      }
                      placeholder="email@example.com, another@example.com"
                      style={{
                        width: "100%",
                        padding: "0.85rem",
                        fontSize: "0.95rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        background: "var(--input-bg)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                        transition: "all 0.2s ease",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor =
                          "var(--accent-color, #6366f1)";
                        e.target.style.background = "var(--input-bg-focus)";
                        e.target.style.boxShadow =
                          "0 0 0 3px rgba(99,102,241,0.1)";
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "var(--border-color)";
                        e.target.style.background = "var(--input-bg)";
                        e.target.style.boxShadow = "none";
                      }}
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.85rem",
                        fontWeight: 700,
                        marginBottom: "0.6rem",
                        color: "var(--text-primary)",
                        letterSpacing: "0.3px",
                      }}
                    >
                      Description
                    </label>
                    <textarea
                      value={editFormData.description}
                      onChange={(e) =>
                        setEditFormData({
                          ...editFormData,
                          description: e.target.value,
                        })
                      }
                      placeholder="Add any notes about this event..."
                      style={{
                        width: "100%",
                        padding: "0.85rem",
                        fontSize: "0.95rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        background: "var(--input-bg)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                        minHeight: "90px",
                        resize: "vertical",
                        fontFamily: "inherit",
                        transition: "all 0.2s ease",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor =
                          "var(--accent-color, #6366f1)";
                        e.target.style.background = "var(--input-bg-focus)";
                        e.target.style.boxShadow =
                          "0 0 0 3px rgba(99,102,241,0.1)";
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "var(--border-color)";
                        e.target.style.background = "var(--input-bg)";
                        e.target.style.boxShadow = "none";
                      }}
                    />
                  </div>

                  {/* Buttons */}
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      marginTop: "1.5rem",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsEditingEvent(false)}
                      style={{
                        padding: "0.65rem 1.5rem",
                        borderRadius: "8px",
                        border: "1px solid var(--border-color)",
                        background: "var(--bg-color)",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: "0.9rem",
                        transition: "all 0.2s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--input-bg)";
                        e.currentTarget.style.borderColor =
                          "var(--border-color)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background =
                          "var(--input-bg-focus)";
                        e.currentTarget.style.borderColor =
                          "var(--border-color)";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={
                        !editFormData.title ||
                        !editFormData.startTime ||
                        !editFormData.endTime ||
                        busy.edit
                      }
                      style={{
                        padding: "0.65rem 1.75rem",
                        borderRadius: "8px",
                        border: "none",
                        background:
                          !editFormData.title ||
                          !editFormData.startTime ||
                          !editFormData.endTime ||
                          busy.edit
                            ? "#d1d5db"
                            : "#6366f1",
                        color: "#fff",
                        cursor:
                          !editFormData.title ||
                          !editFormData.startTime ||
                          !editFormData.endTime ||
                          busy.edit
                            ? "not-allowed"
                            : "pointer",
                        fontWeight: 600,
                        fontSize: "0.9rem",
                        transition: "all 0.2s ease",
                      }}
                      onMouseEnter={(e) => {
                        if (
                          !(
                            !editFormData.title ||
                            !editFormData.startTime ||
                            !editFormData.endTime ||
                            busy.edit
                          )
                        ) {
                          e.currentTarget.style.background =
                            "var(--accent-hover, #4f46e5)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (
                          !(
                            !editFormData.title ||
                            !editFormData.startTime ||
                            !editFormData.endTime ||
                            busy.edit
                          )
                        ) {
                          e.currentTarget.style.background =
                            "var(--accent-color, #6366f1)";
                        }
                      }}
                    >
                      {busy.edit ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Event Modal */}
      {showCreateModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9998,
            animation: "fadeIn 0.25s ease",
          }}
        >
          <div
            style={{
              background: "var(--bg-color)",
              border: "1px solid var(--border-color)",
              borderRadius: "12px",
              boxShadow: "0 10px 40px rgba(0,0,0,0.15)",
              padding: "2rem",
              maxWidth: "520px",
              width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1.5rem",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "1.3rem",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                Create Event in{" "}
                {createProvider === "google" ? "Google" : "Outlook"}
              </h3>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setFormData({
                    title: "",
                    description: "",
                    startTime: "",
                    endTime: "",
                    attendees: "",
                    location: "",
                    createMeet: false,
                    createZoom: false,
                  });
                  setSlotPicker({
                    date: "",
                    slots: [],
                    loading: false,
                    error: "",
                  });
                }}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "1.5rem",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: "0",
                  transition: "color 0.2s ease",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.color = "var(--text-primary)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "var(--text-secondary)")
                }
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={handleCreateEvent}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1.25rem",
              }}
            >
              {/* Title */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    marginBottom: "0.6rem",
                    color: "var(--text-primary)",
                    letterSpacing: "0.3px",
                  }}
                >
                  Event Title <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder="Team Meeting, Client Call, etc."
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  style={{
                    width: "100%",
                    padding: "0.85rem",
                    fontSize: "0.95rem",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                    boxSizing: "border-box",
                    transition: "all 0.2s ease",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--accent-color, #6366f1)";
                    e.target.style.background = "var(--input-bg-focus)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--border-color)";
                    e.target.style.background = "var(--input-bg)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              {/* Start and End Time (side by side) */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      fontWeight: 700,
                      marginBottom: "0.6rem",
                      color: "var(--text-primary)",
                      letterSpacing: "0.3px",
                    }}
                  >
                    Start Time <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.startTime}
                    min={currentLocalDateTimeMin()}
                    autoComplete="off"
                    inputMode="none"
                    onClick={openNativePicker}
                    onKeyDown={blockManualDateEntry}
                    onPaste={(e) => e.preventDefault()}
                    onDrop={(e) => e.preventDefault()}
                    onChange={(e) =>
                      setFormData({ ...formData, startTime: e.target.value })
                    }
                    style={{
                      width: "100%",
                      padding: "0.85rem",
                      fontSize: "0.92rem",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      background: "var(--input-bg)",
                      color: "var(--text-primary)",
                      boxSizing: "border-box",
                      transition: "all 0.2s ease",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor =
                        "var(--accent-color, #6366f1)";
                      e.target.style.background = "var(--input-bg-focus)";
                      e.target.style.boxShadow =
                        "0 0 0 3px rgba(99,102,241,0.1)";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "var(--border-color)";
                      e.target.style.background = "var(--input-bg)";
                      e.target.style.boxShadow = "none";
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      fontWeight: 700,
                      marginBottom: "0.6rem",
                      color: "var(--text-primary)",
                      letterSpacing: "0.3px",
                    }}
                  >
                    End Time <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.endTime}
                    min={formData.startTime || currentLocalDateTimeMin()}
                    autoComplete="off"
                    inputMode="none"
                    onClick={openNativePicker}
                    onKeyDown={blockManualDateEntry}
                    onPaste={(e) => e.preventDefault()}
                    onDrop={(e) => e.preventDefault()}
                    onChange={(e) =>
                      setFormData({ ...formData, endTime: e.target.value })
                    }
                    style={{
                      width: "100%",
                      padding: "0.85rem",
                      fontSize: "0.92rem",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      background: "var(--input-bg)",
                      color: "var(--text-primary)",
                      boxSizing: "border-box",
                      transition: "all 0.2s ease",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor =
                        "var(--accent-color, #6366f1)";
                      e.target.style.background = "var(--input-bg-focus)";
                      e.target.style.boxShadow =
                        "0 0 0 3px rgba(99,102,241,0.1)";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "var(--border-color)";
                      e.target.style.background = "var(--input-bg)";
                      e.target.style.boxShadow = "none";
                    }}
                  />
                </div>
              </div>

              {/* Location */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    marginBottom: "0.6rem",
                    color: "var(--text-primary)",
                    letterSpacing: "0.3px",
                  }}
                >
                  Location
                </label>
                <input
                  type="text"
                  placeholder="Conference Room, Zoom Link, etc."
                  value={formData.location}
                  onChange={(e) =>
                    setFormData({ ...formData, location: e.target.value })
                  }
                  style={{
                    width: "100%",
                    padding: "0.85rem",
                    fontSize: "0.95rem",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                    boxSizing: "border-box",
                    transition: "all 0.2s ease",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--accent-color, #6366f1)";
                    e.target.style.background = "var(--input-bg-focus)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--border-color)";
                    e.target.style.background = "var(--input-bg)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              {/* Attendees */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    marginBottom: "0.6rem",
                    color: "var(--text-primary)",
                    letterSpacing: "0.3px",
                  }}
                >
                  Attendees
                </label>
                {contactOptions.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      addAttendeeEmail(e.target.value);
                      e.target.value = "";
                    }}
                    style={{
                      width: "100%",
                      padding: "0.7rem",
                      fontSize: "0.9rem",
                      marginBottom: "0.5rem",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      background: "var(--bg-color)",
                      color: "var(--text-primary)",
                      boxSizing: "border-box",
                      cursor: "pointer",
                    }}
                  >
                    <option value="">+ Add from contacts…</option>
                    {contactOptions.map((c) => (
                      <option key={c.id} value={c.email}>
                        {c.name} ({c.email})
                      </option>
                    ))}
                  </select>
                )}
                {formData.attendees && (
                  <div
                    aria-label="Selected attendees"
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.45rem",
                      marginBottom: "0.5rem",
                      padding: "0.65rem",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      background: "var(--bg-color)",
                    }}
                  >
                    {formData.attendees
                      .split(",")
                      .map((email) => email.trim())
                      .filter(Boolean)
                      .map((email) => (
                        <span
                          key={email.toLowerCase()}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                            maxWidth: "100%",
                            padding: "0.35rem 0.55rem",
                            borderRadius: "999px",
                            background: "rgba(99,102,241,0.12)",
                            color: "var(--text-primary)",
                            fontSize: "0.82rem",
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {email}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${email}`}
                            title={`Remove ${email}`}
                            onClick={() => removeAttendeeEmail(email)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: 0,
                              border: 0,
                              background: "transparent",
                              color: "inherit",
                              cursor: "pointer",
                            }}
                          >
                            <X size={14} />
                          </button>
                        </span>
                      ))}
                  </div>
                )}
                <input
                  type="text"
                  placeholder="email@example.com, another@example.com"
                  value={formData.attendees}
                  onChange={(e) =>
                    setFormData({ ...formData, attendees: e.target.value })
                  }
                  style={{
                    width: "100%",
                    padding: "0.85rem",
                    fontSize: "0.95rem",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                    boxSizing: "border-box",
                    transition: "all 0.2s ease",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--accent-color, #6366f1)";
                    e.target.style.background = "var(--input-bg-focus)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--border-color)";
                    e.target.style.background = "var(--input-bg)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              {/* Description */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    marginBottom: "0.6rem",
                    color: "var(--text-primary)",
                    letterSpacing: "0.3px",
                  }}
                >
                  Description
                </label>
                <textarea
                  placeholder="Add any notes about this event..."
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  style={{
                    width: "100%",
                    padding: "0.85rem",
                    fontSize: "0.95rem",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                    boxSizing: "border-box",
                    minHeight: "90px",
                    resize: "vertical",
                    fontFamily: "inherit",
                    transition: "all 0.2s ease",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--accent-color, #6366f1)";
                    e.target.style.background = "var(--input-bg-focus)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--border-color)";
                    e.target.style.background = "var(--input-bg)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              {/* Slot-picker + online meeting (Google Meet / Teams) — T18 */}
              {(createProvider === "google" ||
                createProvider === "outlook") && (
                <div
                  style={{
                    border: "1px dashed #d1d5db",
                    borderRadius: "8px",
                    padding: "1rem",
                    background: "var(--input-bg)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.85rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.85rem",
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}
                  >
                    <Video size={15} style={{ color: "#4285F4" }} /> Booking
                    helper
                  </div>

                  {/* Find available slots */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.78rem",
                        fontWeight: 600,
                        marginBottom: "0.4rem",
                        color: "var(--text-primary)",
                      }}
                    >
                      Find available slots
                    </label>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        type="date"
                        value={slotPicker.date}
                        min={formatLocalDateKey(new Date())}
                        autoComplete="off"
                        inputMode="none"
                        onClick={openNativePicker}
                        onKeyDown={blockManualDateEntry}
                        onPaste={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                        onChange={(e) =>
                          setSlotPicker((s) => ({
                            ...s,
                            date: e.target.value,
                            error: "",
                          }))
                        }
                        style={{
                          flex: 1,
                          padding: "0.6rem",
                          fontSize: "0.9rem",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--bg-color)",
                          color: "var(--text-primary)",
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleFindSlots}
                        disabled={slotPicker.loading || !slotPicker.date}
                        style={{
                          padding: "0.6rem 1rem",
                          borderRadius: "8px",
                          border: "1px solid #4285F4",
                          background:
                            slotPicker.loading || !slotPicker.date
                              ? "#e5e7eb"
                              : "rgba(66,133,244,0.1)",
                          color:
                            slotPicker.loading || !slotPicker.date
                              ? "#9ca3af"
                              : "#1a56c4",
                          cursor:
                            slotPicker.loading || !slotPicker.date
                              ? "not-allowed"
                              : "pointer",
                          fontWeight: 600,
                          fontSize: "0.85rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {slotPicker.loading ? "Finding…" : "Find slots"}
                      </button>
                    </div>
                    {slotPicker.error && (
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "#b45309",
                          marginTop: "0.4rem",
                        }}
                      >
                        {slotPicker.error}
                      </div>
                    )}
                    {slotPicker.slots.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.4rem",
                          marginTop: "0.6rem",
                        }}
                      >
                        {slotPicker.slots.map((slot) => {
                          const selected =
                            formData.startTime === isoToLocalInput(slot.start);
                          return (
                            <button
                              key={slot.start}
                              type="button"
                              onClick={() => handlePickSlot(slot)}
                              style={{
                                padding: "0.4rem 0.7rem",
                                borderRadius: "999px",
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                border: selected
                                  ? "1px solid #4285F4"
                                  : "1px solid #e5e7eb",
                                background: selected ? "#4285F4" : "#fff",
                                color: selected ? "#fff" : "#374151",
                                cursor: "pointer",
                              }}
                            >
                              {formatDateTime(slot.start)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Add Google Meet link */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={formData.createMeet}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          createMeet: e.target.checked,
                        })
                      }
                      style={{
                        width: "16px",
                        height: "16px",
                        cursor: "pointer",
                      }}
                    />
                    Add a{" "}
                    {createProvider === "google" ? "Google Meet" : "Teams"}{" "}
                    meeting link to this event
                  </label>

                  {/* Add Zoom link — works for either calendar provider */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={formData.createZoom}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          createZoom: e.target.checked,
                        })
                      }
                      style={{
                        width: "16px",
                        height: "16px",
                        cursor: "pointer",
                      }}
                    />
                    Add a Zoom meeting link to this event
                  </label>
                </div>
              )}

              {/* Buttons */}
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  marginTop: "1.5rem",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setFormData({
                      title: "",
                      description: "",
                      startTime: "",
                      endTime: "",
                      attendees: "",
                      location: "",
                      createMeet: false,
                      createZoom: false,
                    });
                    setSlotPicker({
                      date: "",
                      slots: [],
                      loading: false,
                      error: "",
                    });
                  }}
                  style={{
                    padding: "0.65rem 1.5rem",
                    borderRadius: "8px",
                    border: "1px solid var(--border-color)",
                    background: "var(--bg-color)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: "0.9rem",
                    transition: "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = "var(--input-bg)";
                    e.target.style.borderColor = "var(--border-color)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = "var(--input-bg-focus)";
                    e.target.style.borderColor = "var(--border-color)";
                  }}
                >
                  Cancel
                </button>
              <button
                  type="button"
                  onClick={handleCreateEvent}
                  disabled={
                    !formData.title ||
                    !formData.startTime ||
                    !formData.endTime ||
                    busy[createProvider]
                  }
                  style={{
                    padding: "0.65rem 1.75rem",
                    borderRadius: "8px",
                    border: "none",
                    background:
                      !formData.title ||
                      !formData.startTime ||
                      !formData.endTime ||
                      busy[createProvider]
                        ? "#d1d5db"
                        : "#6366f1",
                    color: "#fff",
                    cursor:
                      !formData.title ||
                      !formData.startTime ||
                      !formData.endTime ||
                      busy[createProvider]
                        ? "not-allowed"
                        : "pointer",
                    fontWeight: 600,
                    fontSize: "0.9rem",
                    transition: "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (
                      !(
                        !formData.title ||
                        !formData.startTime ||
                        !formData.endTime ||
                        busy[createProvider]
                      )
                    ) {
                      e.target.style.background =
                        "var(--accent-hover, #4f46e5)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (
                      !(
                        !formData.title ||
                        !formData.startTime ||
                        !formData.endTime ||
                        busy[createProvider]
                      )
                    ) {
                      e.target.style.background =
                        "var(--accent-color, #6366f1)";
                    }
                  }}
                >
                  {busy[createProvider] ? "Creating..." : "Create Event"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
