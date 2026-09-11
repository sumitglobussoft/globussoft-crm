const prisma = require("../lib/prisma");
const { google } = require("googleapis");
// Node 18+ ships a built-in global `fetch` — same as routes/email_scheduling.js
// + services/smsProvider.js + the other fetch callsites in this codebase.
// PR #566 originally did `require("node-fetch")` here, but node-fetch is NOT
// in backend/package.json — that crashed the module at load time. Drop the
// require; use the global. API surface is identical for our use cases (form-
// urlencoded body for OAuth token exchange + JSON for Google / Microsoft
// Calendar HTTP calls).

// Helper to build Google OAuth client
function buildGoogleOAuthClient(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Helper to get authorized Google Calendar client
async function getAuthorizedGoogleClient(userId, tenantId) {
  const integration = await prisma.calendarIntegration.findUnique({
    where: { tenantId_userId_provider: { tenantId, userId, provider: "google" } },
  });
  if (!integration) {
    throw { status: 404, message: "Google Calendar not connected" };
  }

  const oauth2Client = buildGoogleOAuthClient(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt ? integration.expiresAt.getTime() : undefined,
  });

  oauth2Client.on("tokens", async (tokens) => {
    try {
      const data = {};
      if (tokens.access_token) data.accessToken = tokens.access_token;
      if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
      if (Object.keys(data).length) {
        await prisma.calendarIntegration.update({
          where: { tenantId_userId_provider: { tenantId, userId, provider: "google" } },
          data,
        });
      }
    } catch (e) {
      console.error("[calendarEventController] failed to persist refreshed tokens:", e.message);
    }
  });

  return { client: oauth2Client, integration };
}

// Helper to refresh Outlook token if needed
async function refreshOutlookTokenIfNeeded(integration) {
  if (!integration) return integration;
  const now = new Date();
  if (integration.expiresAt && new Date(integration.expiresAt) > now) {
    return integration;
  }
  if (!integration.refreshToken) {
    throw new Error("No refresh token on integration; user must reconnect.");
  }

  const params = new URLSearchParams();
  params.append("client_id", process.env.MS_CLIENT_ID || "");
  params.append("client_secret", process.env.MS_CLIENT_SECRET || "");
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", integration.refreshToken);
  params.append("scope", "offline_access Calendars.ReadWrite User.Read");
  params.append("redirect_uri", process.env.MS_REDIRECT_URI || "");

  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  const updated = await prisma.calendarIntegration.update({
    where: { id: integration.id },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || integration.refreshToken,
      expiresAt,
    },
  });
  return updated;
}

// ==================== UPDATE EVENT ====================
exports.updateCalendarEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, startTime, endTime, location, attendees } = req.body;
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;

    if (!id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    // Validate dates if provided
    if (startTime || endTime) {
      const start = startTime ? new Date(startTime) : undefined;
      const end = endTime ? new Date(endTime) : undefined;

      if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime()))) {
        return res.status(400).json({ error: "Invalid startTime or endTime format" });
      }

      if (start && end && end <= start) {
        return res.status(400).json({ error: "End time must be after start time" });
      }

      if (start && start < new Date()) {
        return res.status(400).json({ error: "Cannot set start time in the past" });
      }
    }

    // Find the event
    const event = await prisma.calendarEvent.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (event.userId !== userId || event.tenantId !== tenantId) {
      return res.status(403).json({ error: "Unauthorized to edit this event" });
    }

    // Once a meeting has started, keep its record immutable. This mirrors the
    // UI lock and prevents edits through direct API calls as well.
    const eventStart = new Date(event.startTime);
    const eventEnd = new Date(event.endTime);
    const now = new Date();
    if (
      !isNaN(eventStart.getTime()) &&
      !isNaN(eventEnd.getTime()) &&
      eventStart <= now &&
      eventEnd > now
    ) {
      return res.status(409).json({ error: "In-progress meetings cannot be edited" });
    }

    const provider = event.provider;

    // Update in external calendar first
    if (provider === "google") {
      const { client, integration } = await getAuthorizedGoogleClient(userId, tenantId);
      const calendar = google.calendar({ version: "v3", auth: client });

      const updateBody = {
        summary: title || event.title,
        description: description !== undefined ? description : event.description,
        location: location || event.location,
      };

      if (startTime || endTime) {
        updateBody.start = { dateTime: new Date(startTime || event.startTime).toISOString() };
        updateBody.end = { dateTime: new Date(endTime || event.endTime).toISOString() };
      }

      if (attendees) {
        const attendeesArr = Array.isArray(attendees)
          ? attendees.map((a) => (typeof a === "string" ? { email: a } : a)).filter((a) => a?.email)
          : [];
        updateBody.attendees = attendeesArr.length ? attendeesArr : [];
      }

      await calendar.events.update({
        calendarId: integration.calendarId || "primary",
        eventId: event.externalId,
        requestBody: updateBody,
      });
    } else if (provider === "microsoft") {
      let integration = await prisma.calendarIntegration.findUnique({
        where: { tenantId_userId_provider: { tenantId, userId, provider: "microsoft" } },
      });
      if (!integration) {
        return res.status(404).json({ error: "Outlook calendar not connected" });
      }

      integration = await refreshOutlookTokenIfNeeded(integration);

      const updateBody = {
        subject: title || event.title,
        body: { contentType: "HTML", content: description || event.description || "" },
        location: location ? { displayName: location } : undefined,
      };

      if (startTime || endTime) {
        updateBody.start = {
          dateTime: new Date(startTime || event.startTime).toISOString(),
          timeZone: "UTC",
        };
        updateBody.end = {
          dateTime: new Date(endTime || event.endTime).toISOString(),
          timeZone: "UTC",
        };
      }

      if (attendees) {
        const attendeesArr = Array.isArray(attendees) ? attendees : [];
        updateBody.attendees = attendeesArr.map((a) => ({
          emailAddress: {
            address: typeof a === "string" ? a : a.email,
            name: typeof a === "string" ? a : a.name || a.email,
          },
          type: "required",
        }));
      }

      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendar/events/${event.externalId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${integration.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateBody),
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(502).json({ error: `Graph update failed: ${errText}` });
      }
    }

    // Update in database
    const updated = await prisma.calendarEvent.update({
      where: { id: parseInt(id, 10) },
      data: {
        title: title || undefined,
        description: description !== undefined ? description : undefined,
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined,
        location: location !== undefined ? location : undefined,
        attendees: attendees ? JSON.stringify(Array.isArray(attendees) ? attendees : []) : undefined,
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error("[calendarEventController] updateCalendarEvent error:", err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to update event" });
  }
};

// ==================== DELETE EVENT ====================
exports.deleteCalendarEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;

    if (!id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    // Find the event
    const event = await prisma.calendarEvent.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (event.userId !== userId || event.tenantId !== tenantId) {
      return res.status(403).json({ error: "Unauthorized to delete this event" });
    }

    const provider = event.provider;

    // Delete from external calendar first
    if (provider === "google") {
      const { client, integration } = await getAuthorizedGoogleClient(userId, tenantId);
      const calendar = google.calendar({ version: "v3", auth: client });

      try {
        await calendar.events.delete({
          calendarId: integration.calendarId || "primary",
          eventId: event.externalId,
        });
      } catch (err) {
        console.error("[calendarEventController] Google delete error:", err.message);
        // Don't fail if external delete fails, still delete from DB
      }
    } else if (provider === "microsoft") {
      let integration = await prisma.calendarIntegration.findUnique({
        where: { tenantId_userId_provider: { tenantId, userId, provider: "microsoft" } },
      });

      if (integration) {
        try {
          integration = await refreshOutlookTokenIfNeeded(integration);

          const resp = await fetch(
            `https://graph.microsoft.com/v1.0/me/calendar/events/${event.externalId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${integration.accessToken}` },
            }
          );

          if (!resp.ok) {
            console.error("[calendarEventController] Outlook delete error:", resp.status);
            // Don't fail if external delete fails, still delete from DB
          }
        } catch (err) {
          console.error("[calendarEventController] Outlook delete error:", err.message);
          // Don't fail if external delete fails, still delete from DB
        }
      }
    }

    // Delete from database
    await prisma.calendarEvent.delete({
      where: { id: parseInt(id, 10) },
    });

    return res.json({ success: true, message: "Event deleted successfully" });
  } catch (err) {
    console.error("[calendarEventController] deleteCalendarEvent error:", err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to delete event" });
  }
};
