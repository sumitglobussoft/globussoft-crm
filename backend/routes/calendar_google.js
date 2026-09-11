// Google Calendar OAuth + sync integration
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");
const { parseSlotWindow, freeSlots } = require("../lib/calendarSlots");
const zoomClient = require("../services/zoomClient");

function includesBirthdayText(value) {
  return /birthday/i.test(String(value || ""));
}

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET ||
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
  "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
  "http://localhost:5000/api/calendar/google/callback";
// Strip trailing slash AND a stray "/api" suffix so a deployment whose
// FRONTEND_URL is mistakenly set to the API base (e.g. https://host/api)
// still produces a working SPA link instead of /api/calendar-sync.
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173")
  .replace(/\/+$/, "")
  .replace(/\/api$/i, "");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function buildOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}

async function getAuthorizedClientForUser(userId, tenantId) {
  const integration = await prisma.calendarIntegration.findUnique({
    where: {
      tenantId_userId_provider: { tenantId, userId, provider: "google" },
    },
  });
  if (!integration) {
    const err = new Error(
      "Google Calendar not connected. Please connect your calendar first via /api/calendar/google/connect",
    );
    err.status = 404;
    throw err;
  }
  const client = buildOAuthClient();
  client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt
      ? integration.expiresAt.getTime()
      : undefined,
  });

  // Persist refreshed tokens automatically
  client.on("tokens", async (tokens) => {
    try {
      const data = {};
      if (tokens.access_token) data.accessToken = tokens.access_token;
      if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
      if (Object.keys(data).length) {
        await prisma.calendarIntegration.update({
          where: {
            tenantId_userId_provider: { tenantId, userId, provider: "google" },
          },
          data,
        });
      }
    } catch (e) {
      console.error(
        "[calendar_google] failed to persist refreshed tokens:",
        e.message,
      );
    }
  });

  return { client, integration };
}

// GET /connect — generate OAuth URL
router.get("/connect", verifyToken, (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res
        .status(500)
        .json({ error: "Google OAuth credentials not configured on server" });
    }
    const oauth2Client = buildOAuthClient();
    const state = encodeState({
      userId: req.user.userId,
      tenantId: req.user.tenantId,
      t: Date.now(),
    });
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });
    res.json({ authUrl });
  } catch (err) {
    console.error("[calendar_google] /connect error:", err);
    res.status(500).json({ error: "Failed to generate Google OAuth URL" });
  }
});

// GET /callback — public (no auth) — receives code+state, stores tokens
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(
      `${FRONTEND_URL}/calendar-sync?error=${encodeURIComponent(error)}`,
    );
  }
  if (!code || !state) {
    return res.redirect(
      `${FRONTEND_URL}/calendar-sync?error=missing_code_or_state`,
    );
  }
  const decoded = decodeState(state);
  if (!decoded || !decoded.userId) {
    return res.redirect(`${FRONTEND_URL}/calendar-sync?error=invalid_state`);
  }
  try {
    const oauth2Client = buildOAuthClient();
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error(
        "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in env",
      );
    }
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens || !tokens.access_token) {
      throw new Error("No access token received from Google");
    }
    const userId = parseInt(decoded.userId, 10);
    const tenantId = decoded.tenantId ? parseInt(decoded.tenantId, 10) : 1;

    await prisma.calendarIntegration.upsert({
      where: {
        tenantId_userId_provider: { tenantId, userId, provider: "google" },
      },
      create: {
        userId,
        provider: "google",
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        calendarId: "primary",
        syncEnabled: true,
        tenantId,
      },
      update: {
        accessToken: tokens.access_token || "",
        // Keep existing refresh token if Google doesn't send a new one
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        syncEnabled: true,
        tenantId,
      },
    });

    // Use HTML redirect to preserve browser session/token
    const redirectUrl = `${FRONTEND_URL}/calendar-sync?connected=google`;
    res.send(`
      <script>
        window.location.href = '${redirectUrl}';
      </script>
      <p>Redirecting to Calendar Sync...</p>
    `);
  } catch (err) {
    console.error("[calendar_google] /callback error:", err.message || err);
    console.error("[calendar_google] Redirect URI used:", GOOGLE_REDIRECT_URI);
    console.error(
      "[calendar_google] Client ID:",
      GOOGLE_CLIENT_ID ? "✓ set" : "✗ missing",
    );
    console.error(
      "[calendar_google] Client Secret:",
      GOOGLE_CLIENT_SECRET ? "✓ set" : "✗ missing",
    );
    res.redirect(
      `${FRONTEND_URL}/calendar-sync?error=${encodeURIComponent("token_exchange_failed")}`,
    );
  }
});

// POST /sync — pull events from Google Calendar into DB
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }
    const tenantId = req.user.tenantId;
    const { client, integration } = await getAuthorizedClientForUser(
      userId,
      tenantId,
    );
    const calendar = google.calendar({ version: "v3", auth: client });

    const now = Date.now();
    const timeMin = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // last 30d
    const timeMax = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(); // next 90d
    const timeMinDate = new Date(timeMin);
    const timeMaxDate = new Date(timeMax);

    let pageToken = undefined;
    let synced = 0;
    const seenExternalIds = new Set();
    do {
      const resp = await calendar.events.list({
        calendarId: integration.calendarId || "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
      });
      const events = resp.data.items || [];
      for (const ev of events) {
        if (!ev.id) continue;
        seenExternalIds.add(ev.id);
        const start = ev.start && (ev.start.dateTime || ev.start.date);
        const end = ev.end && (ev.end.dateTime || ev.end.date);
        if (!start || !end) continue;
        const startTime = new Date(start);
        const endTime = new Date(end);
        const attendeesJson = ev.attendees
          ? JSON.stringify(ev.attendees)
          : null;
        const meetingUrl =
          ev.hangoutLink ||
          (ev.conferenceData &&
            ev.conferenceData.entryPoints &&
            (
              ev.conferenceData.entryPoints.find(
                (e) => e.entryPointType === "video",
              ) || {}
            ).uri) ||
          null;

        await prisma.calendarEvent.upsert({
          where: {
            tenantId_provider_externalId: {
              tenantId,
              provider: "google",
              externalId: ev.id,
            },
          },
          create: {
            externalId: ev.id,
            provider: "google",
            title: ev.summary || "(No title)",
            description: ev.description || null,
            startTime,
            endTime,
            location: ev.location || null,
            attendees: attendeesJson,
            meetingUrl,
            userId,
            tenantId,
          },
          update: {
            title: ev.summary || "(No title)",
            description: ev.description || null,
            startTime,
            endTime,
            location: ev.location || null,
            attendees: attendeesJson,
            meetingUrl,
            tenantId,
          },
        });
        synced++;
      }
      pageToken = resp.data.nextPageToken || undefined;
    } while (pageToken);

    await prisma.calendarEvent.deleteMany({
      where: {
        tenantId,
        userId,
        provider: "google",
        externalId: { notIn: Array.from(seenExternalIds) },
        startTime: {
          gte: timeMinDate,
          lte: timeMaxDate,
        },
      },
    });

    await prisma.calendarIntegration.update({
      where: {
        tenantId_userId_provider: { tenantId, userId, provider: "google" },
      },
      data: { lastSyncAt: new Date() },
    });

    return res.json({ success: true, synced });
  } catch (err) {
    console.error("[calendar_google] /sync error:", err);
    // A revoked / expired Google refresh token surfaces as invalid_grant
    // (or "Token has been expired or revoked") from googleapis. That's a
    // re-auth condition — show a friendly reconnect prompt, never the raw
    // OAuth/Graph error to the user.
    const raw = `${(err && err.message) || ""} ${err && err.response && err.response.data ? JSON.stringify(err.response.data) : ""}`;
    const reauth =
      /invalid_grant|expired or revoked|Token has been expired/i.test(raw);
    if (reauth) {
      return res.status(401).json({
        error:
          "Your Google Calendar connection has expired. Please disconnect and reconnect to resume syncing.",
        code: "RECONNECT_REQUIRED",
      });
    }
    // Deliberate errors carry a status + clear message (e.g. 404 not-connected)
    // — keep them. Only mask truly-unexpected errors (no status) so a raw
    // googleapis/OAuth dump never reaches the user.
    if (err.status) {
      return res
        .status(err.status)
        .json({ error: err.message || "Sync failed" });
    }
    return res
      .status(500)
      .json({
        error:
          "Couldn't sync your Google Calendar right now. Please try again.",
      });
  }
});

// GET /events — list synced events for current user/tenant
router.get("/events", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;

    // Check if integration exists first
    const integration = await prisma.calendarIntegration.findUnique({
      where: {
        tenantId_userId_provider: { tenantId, userId, provider: "google" },
      },
    });

    if (!integration) {
      return res.status(404).json({ error: "Google Calendar not connected" });
    }

    const events = await prisma.calendarEvent.findMany({
      where: {
        userId,
        tenantId,
        provider: "google",
      },
      orderBy: { startTime: "asc" },
    });
    return res.json(events);
  } catch (err) {
    console.error("[calendar_google] /events error:", err);
    return res.status(500).json({ error: "Failed to load events" });
  }
});

// POST /events — create event in Google Calendar + DB
router.post("/events", verifyToken, async (req, res) => {
  try {
    const {
      title,
      description,
      startTime,
      endTime,
      startDate,
      endDate,
      attendees,
      contactId,
      dealId,
      location,
      createMeet,
      createZoom,
      conferencing,
      allDay,
      recurrence,
    } = req.body || {};
    const wantsAllDay = allDay === true || allDay === "true";
    if (wantsAllDay ? (!title || !startDate) : (!title || !startTime || !endTime)) {
      return res
        .status(400)
        .json({
          error: wantsAllDay
            ? "title and startDate are required for all-day events"
            : "title, startTime and endTime are required",
        });
    }

    // Opt-in Google Meet link generation (T18). Off by default so every
    // existing caller's behavior is unchanged; Travel's consultation-call
    // booking flow passes createMeet:true (or conferencing:'google_meet')
    // to mint a Meet link on the event.
    const wantsMeet =
      createMeet === true ||
      createMeet === "true" ||
      conferencing === "google_meet" ||
      conferencing === "meet";

    // Opt-in Zoom link generation. Independent of the calendar provider — a
    // Zoom meeting is created via the Zoom API and its join link is woven into
    // the event description (Zoom isn't a native Google conference solution).
    // No-op when Zoom creds are absent (zoomClient.createMeeting returns null).
    const wantsZoom =
      createZoom === true || createZoom === "true" || conferencing === "zoom";
    const isBirthdayLikeEvent =
      wantsAllDay &&
      includesBirthdayText(`${String(title || "")} ${String(description || "")}`);

    const formatDateKey = (date) => {
      const d = date instanceof Date ? date : new Date(date);
      if (!Number.isFinite(d.getTime())) return "";
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    // Validate and parse dates
    const start = wantsAllDay
      ? new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`)
      : new Date(startTime);
    const resolvedEndDate = wantsAllDay ? (endDate || startDate) : endTime;
    const end = wantsAllDay
      ? new Date(`${String(resolvedEndDate).slice(0, 10)}T00:00:00.000Z`)
      : new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ error: "Invalid startTime or endTime format" });
    }

    const now = new Date();
    if (wantsAllDay) {
      const todayKey = formatDateKey(now);
      const startKey = String(startDate).slice(0, 10);
      const endKey = String(resolvedEndDate).slice(0, 10);
      if (!startKey || !endKey) {
        return res
          .status(400)
          .json({ error: "Invalid startDate or endDate format" });
      }
      if (startKey < todayKey) {
        return res
          .status(400)
          .json({
            error:
              "Cannot create events in the past. Start date must be today or later.",
          });
      }
      if (endKey <= startKey) {
        return res
          .status(400)
          .json({ error: "End date must be after start date" });
      }
    } else {
      if (start < now) {
        return res
          .status(400)
          .json({
            error:
              "Cannot create events in the past. Start time must be in the future.",
          });
      }

      if (end <= start) {
        return res
          .status(400)
          .json({ error: "End time must be after start time" });
      }
    }

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }
    const tenantId = req.user.tenantId;

    // Birthday events are informational, not availability blockers.
    // They may overlap with meetings or other birthdays on the same day.
    if (!isBirthdayLikeEvent) {
      const overlappingEvents = await prisma.calendarEvent.findMany({
        where: {
          userId,
          tenantId,
          startTime: { lt: end },
          endTime: { gt: start },
        },
        select: {
          title: true,
          description: true,
        },
      });
      const conflictingEvent = overlappingEvents.find(
        (event) => !includesBirthdayText(`${event?.title || ""} ${event?.description || ""}`),
      );
      if (conflictingEvent) {
        return res
          .status(409)
          .json({
            error:
              "Event time conflicts with an existing event. Please choose a different time.",
          });
      }
    }

    const { client, integration } = await getAuthorizedClientForUser(
      userId,
      tenantId,
    );
    const calendar = google.calendar({ version: "v3", auth: client });

    const attendeesArr = Array.isArray(attendees)
      ? attendees
        .map((a) => (typeof a === "string" ? { email: a } : a))
        .filter((a) => a && a.email)
      : [];

    // Create the Zoom meeting up-front (if requested + configured) so its join
    // link can ride into the calendar event's description + be persisted.
    let zoomUrl = null;
    if (wantsZoom) {
      try {
        const zoom = await zoomClient.createMeeting({
          topic: title,
          startTime: wantsAllDay ? start.toISOString() : startTime,
          durationMins: Math.round((end - start) / 60000),
          agenda: description,
        });
        zoomUrl = zoom && zoom.joinUrl ? zoom.joinUrl : null;
      } catch (e) {
        console.error(
          "[calendar_google] Zoom meeting creation failed:",
          e.message,
        );
      }
    }
    const eventDescription = zoomUrl
      ? `${description ? description + "\n\n" : ""}Join Zoom Meeting:\n${zoomUrl}`
      : description;

    const requestBody = {
      summary: title,
      description: eventDescription || undefined,
      location: location || undefined,
      attendees: attendeesArr.length ? attendeesArr : undefined,
    };
    if (wantsAllDay) {
      requestBody.start = { date: String(startDate).slice(0, 10) };
      requestBody.end = { date: String(resolvedEndDate).slice(0, 10) };
      const recurrenceRules = Array.isArray(recurrence)
        ? recurrence.map((rule) => String(rule).trim()).filter(Boolean)
        : [];
      if (recurrenceRules.length) {
        requestBody.recurrence = recurrenceRules;
      }
      if (isBirthdayLikeEvent) {
        requestBody.transparency = "transparent";
      }
    } else {
      requestBody.start = { dateTime: new Date(startTime).toISOString() };
      requestBody.end = { dateTime: new Date(endTime).toISOString() };
    }
    if (wantsMeet) {
      // Ask Google to provision a Meet conference for this event. requestId
      // must be unique per create-request; a UUID satisfies that.
      requestBody.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const insertResp = await calendar.events.insert({
      calendarId: integration.calendarId || "primary",
      // conferenceDataVersion:1 is REQUIRED for Google to honor the
      // createRequest above. Omitted entirely when no Meet is requested so
      // the call shape is identical to the pre-T18 behavior.
      ...(wantsMeet ? { conferenceDataVersion: 1 } : {}),
      // Email the invitation (with the Meet link) to attendees. Without
      // sendUpdates Google adds them to the event but never notifies them.
      ...(attendeesArr.length ? { sendUpdates: "all" } : {}),
      requestBody,
    });

    const ev = insertResp.data;
    const meetingUrl =
      ev.hangoutLink ||
      (ev.conferenceData &&
        ev.conferenceData.entryPoints &&
        (
          ev.conferenceData.entryPoints.find(
            (e) => e.entryPointType === "video",
          ) || {}
        ).uri) ||
      zoomUrl ||
      null;

    const saved = await prisma.calendarEvent.upsert({
      where: {
        tenantId_provider_externalId: {
          tenantId,
          provider: "google",
          externalId: ev.id,
        },
      },
      create: {
        externalId: ev.id,
        provider: "google",
        title: ev.summary || title,
        description: ev.description || eventDescription || null,
        startTime: wantsAllDay
          ? new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`)
          : new Date(startTime),
        endTime: wantsAllDay
          ? new Date(`${String(resolvedEndDate).slice(0, 10)}T00:00:00.000Z`)
          : new Date(endTime),
        location: location || null,
        attendees: attendeesArr.length ? JSON.stringify(attendeesArr) : null,
        meetingUrl,
        userId,
        contactId: contactId ? parseInt(contactId, 10) : null,
        dealId: dealId ? parseInt(dealId, 10) : null,
        tenantId,
      },
      update: {
        title: ev.summary || title,
        description: ev.description || eventDescription || null,
        startTime: wantsAllDay
          ? new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`)
          : new Date(startTime),
        endTime: wantsAllDay
          ? new Date(`${String(resolvedEndDate).slice(0, 10)}T00:00:00.000Z`)
          : new Date(endTime),
        location: location || null,
        attendees: attendeesArr.length ? JSON.stringify(attendeesArr) : null,
        meetingUrl,
        contactId: contactId ? parseInt(contactId, 10) : null,
        dealId: dealId ? parseInt(dealId, 10) : null,
      },
    });

    return res.status(201).json(saved);
  } catch (err) {
    console.error("[calendar_google] POST /events error:", err);
    const raw = `${(err && err.message) || ""} ${err && err.response && err.response.data ? JSON.stringify(err.response.data) : ""}`;
    if (/invalid_grant|expired or revoked|Token has been expired/i.test(raw)) {
      return res.status(401).json({
        error:
          "Your Google Calendar connection has expired. Please disconnect and reconnect, then create the event again.",
        code: "RECONNECT_REQUIRED",
      });
    }
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to create event" });
  }
});

// GET /slots — free/busy availability for a slot-picker (T18).
//
// Backs the consultation-call booking UI: given a day + slot length + working
// hours, returns the bookable slots that don't overlap the connected
// calendar's busy blocks. Additive + vertical-agnostic — wellness has its own
// separate availability endpoints (/api/wellness/doctors/...) and never calls
// this route.
//
// Query params:
//   date          (required) YYYY-MM-DD — the day to search
//   durationMins  (optional) slot length in minutes (default 30)
//   startHour     (optional) working-day start hour 0..23 (default 9)
//   endHour       (optional) working-day end hour 1..24, exclusive (default 18)
//   stepMins      (optional) gap between slot starts (default = durationMins)
//   tzOffsetMins  (optional) minutes to add to UTC for the user's local
//                 wall-clock (e.g. 330 for IST). Default 0 (UTC).
router.get("/slots", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }

    const win = parseSlotWindow(req.query);
    if (win.error) return res.status(400).json({ error: win.error });

    const { client, integration } = await getAuthorizedClientForUser(
      userId,
      tenantId,
    );
    const calendar = google.calendar({ version: "v3", auth: client });
    const calId = integration.calendarId || "primary";

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(win.windowStartMs).toISOString(),
        timeMax: new Date(win.windowEndMs).toISOString(),
        items: [{ id: calId }],
      },
    });

    const busy = (
      (fb.data &&
        fb.data.calendars &&
        fb.data.calendars[calId] &&
        fb.data.calendars[calId].busy) ||
      []
    ).map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
    }));

    // Google free/busy marks an all-day birthday as busy for the whole day.
    // Birthdays are informational in this CRM, so remove their intervals from
    // the busy set before calculating meeting slots. Real meetings remain
    // blocking.
    let birthdayBusy = [];
    try {
      const birthdayEvents = await calendar.events.list({
        calendarId: calId,
        timeMin: new Date(win.windowStartMs).toISOString(),
        timeMax: new Date(win.windowEndMs).toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        fields: "items(summary,description,start,end)",
      });
      birthdayBusy = (birthdayEvents?.data?.items || [])
        .filter((event) =>
          includesBirthdayText(`${event?.summary || ""} ${event?.description || ""}`),
        )
        .map((event) => ({
          start: new Date(event.start?.dateTime || event.start?.date).getTime(),
          end: new Date(event.end?.dateTime || event.end?.date).getTime(),
        }))
        .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end));
    } catch (birthdayLookupError) {
      // Free/busy is still useful if the supplemental event lookup fails.
      console.warn("[calendar_google] birthday transparency lookup failed:", birthdayLookupError.message);
    }

    const effectiveBusy = busy.flatMap((interval) => {
      let remaining = [interval];
      birthdayBusy.forEach((birthday) => {
        remaining = remaining.flatMap((segment) => {
          if (birthday.end <= segment.start || birthday.start >= segment.end) {
            return [segment];
          }
          const pieces = [];
          if (segment.start < birthday.start) {
            pieces.push({ start: segment.start, end: birthday.start });
          }
          if (birthday.end < segment.end) {
            pieces.push({ start: birthday.end, end: segment.end });
          }
          return pieces;
        });
      });
      return remaining;
    });

    const slots = freeSlots(
      win.windowStartMs,
      win.windowEndMs,
      effectiveBusy,
      win.durationMins,
      win.stepMins,
      Date.now(),
    );

    return res.json({
      date: win.dateStr,
      durationMins: win.durationMins,
      busyCount: effectiveBusy.length,
      workingHours: { start: 9, end: 18 },
      timeMin: new Date(win.windowStartMs).toISOString(),
      timeMax: new Date(win.windowEndMs).toISOString(),
      slots,
    });
  } catch (err) {
    console.error("[calendar_google] GET /slots error:", err);
    // A revoked / expired Google refresh token surfaces as invalid_grant — a
    // re-auth condition, not a server fault. Mirror the /sync reconnect prompt.
    const raw = `${(err && err.message) || ""} ${err && err.response && err.response.data ? JSON.stringify(err.response.data) : ""}`;
    if (/invalid_grant|expired or revoked|Token has been expired/i.test(raw)) {
      return res.status(401).json({
        error:
          "Your Google Calendar connection has expired. Please disconnect and reconnect to find available slots.",
        code: "RECONNECT_REQUIRED",
      });
    }
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to load slots" });
  }
});

// DELETE /disconnect — remove integration row
router.delete("/disconnect", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;
    await prisma.calendarIntegration
      .delete({
        where: { tenantId_userId_provider: { tenantId, userId, provider: "google" } },
      })
      .catch((err) => {
        if (err && err.code === "P2025") return null; // not found is fine
        throw err;
      });
    return res.json({ success: true });
  } catch (err) {
    console.error("[calendar_google] /disconnect error:", err);
    return res.status(500).json({ error: "Failed to disconnect" });
  }
});

module.exports = router;
