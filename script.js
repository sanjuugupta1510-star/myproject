const savedProfile = JSON.parse(localStorage.getItem('nariProfileV1') || 'null');
const userId = localStorage.getItem('nariUserId') || (crypto.randomUUID ? crypto.randomUUID() : `user_${Date.now()}`);
localStorage.setItem('nariUserId', userId);

function sanitizeContact(contact, index) {
  if (!contact || typeof contact !== 'object') return null;

  const name = String(contact.name || '').trim();
  const relation = String(contact.relation || '').trim();
  const phone = String(contact.phone || '').trim();
  const normalizedName = name.toLowerCase();

  if (!name || !phone || !relation) return null;
  if (['nauserme', 'user', 'demo user', 'test user', 'n/a', 'unknown'].includes(normalizedName)) return null;

  return {
    ...contact,
    id: contact.id || `contact_saved_${index}`,
    name,
    relation,
    phone,
    status: contact.status || 'Pending verification'
  };
}

function sanitizeTrustedContacts(contacts = []) {
  if (!Array.isArray(contacts)) return [];
  return contacts.map((contact, index) => sanitizeContact(contact, index)).filter(Boolean);
}

const savedContacts = JSON.parse(localStorage.getItem('nariTrustedContactsV3') || 'null');
const trustedContacts = sanitizeTrustedContacts(savedContacts || savedProfile?.trustedContacts || []);
if (Array.isArray(savedContacts)) {
  localStorage.setItem('nariTrustedContactsV3', JSON.stringify(trustedContacts));
}

const emergencyHistory = [];

const state = {
  profile: savedProfile,
  currentScreen: 'home',
  wizardStep: 1,
  emergencyStatus: 'Secure & ready',
  emergencyActive: false,
  safeJourneyActive: false,
  timerActive: false,
  location: {
    latitude: null,
    longitude: null,
    ...(savedProfile?.location || {}),
    address: savedProfile?.location?.address || 'Location not enabled',
    accuracy: null,
    battery: null,
    source: null
  },
  locationWatchId: null,
  appLocked: localStorage.getItem('nariAppLocked') === 'true',
  doubleTapEmergency: localStorage.getItem('nariDoubleTapEmergency') === 'true',
  lastTapAt: 0,
  selectedContactId: trustedContacts[0]?.id || null
};

const apiBase = window.location.port === '3000' ? '' : 'http://localhost:3000';

const tabs = document.querySelectorAll('.tab-button');
const screens = document.querySelectorAll('.screen');
const onboardingOverlay = document.getElementById('onboardingOverlay');
const wizardPrev = document.getElementById('wizardPrev');
const wizardNext = document.getElementById('wizardNext');
const wizardSteps = document.querySelectorAll('.wizard-step');
const statusBadge = document.getElementById('statusBadge');
const emergencyStatusLabel = document.getElementById('emergencyStatusLabel');
const systemStatus = document.getElementById('systemStatus');
const updateTime = document.getElementById('updateTime');
const locationLabel = document.getElementById('locationLabel');
const locationCoords = document.querySelector('.coordinates span:first-child');
const locationAccuracy = document.querySelector('.coordinates span:last-child');
const batteryValue = document.querySelector('.meta-grid div:first-child strong');
const dashboardLocation = document.getElementById('dashboardLocation');
const contactModal = document.getElementById('contactModal');
const selectedContactLabel = document.getElementById('selectedContactLabel');
const appLockOverlay = document.getElementById('appLockOverlay');

function setAppLocked(locked) {
  state.appLocked = locked;
  localStorage.setItem('nariAppLocked', String(locked));
  appLockOverlay.classList.toggle('visible', locked);
  appLockOverlay.setAttribute('aria-hidden', String(!locked));
  document.body.classList.toggle('app-locked', locked);
  const lockStatus = document.getElementById('lockStatus');
  if (lockStatus) lockStatus.textContent = locked
    ? 'Safety mode is active. Emergency controls remain available.'
    : 'When locked, emergency actions remain available but other controls are hidden.';
}

function handleDoubleTap() {
  if (!state.doubleTapEmergency) return;
  const now = Date.now();
  if (now - state.lastTapAt < 450) {
    state.lastTapAt = 0;
    setAppLocked(true);
    handleEmergencyStart({ autoCall: true });
    return;
  }
  state.lastTapAt = now;
}

function updateProfileDisplay() {
  const profile = state.profile;
  const name = profile?.name || 'Your profile';
  const initials = name === 'Your profile'
    ? '--'
    : name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const profileAvatar = document.getElementById('profileAvatar');
  const profileDisplayName = document.getElementById('profileDisplayName');
  const dashboardAlertText = document.getElementById('dashboardAlertText');
  if (profileAvatar) profileAvatar.textContent = initials;
  if (profileDisplayName) profileDisplayName.textContent = name;
  if (dashboardAlertText) dashboardAlertText.textContent = profile ? `${name}'s emergency status` : 'Complete your profile to activate safety monitoring';
}

function formatCoordinates(latitude, longitude) {
  if (latitude === null || longitude === null) {
    return 'Enable location to see coordinates';
  }
  return `${Number(latitude).toFixed(4)}, ${Number(longitude).toFixed(4)}`;
}

function updateLocationDisplay() {
  const { latitude, longitude, address, accuracy, battery, source } = state.location;
  locationLabel.textContent = address || 'Current GPS Location';
  locationCoords.textContent = formatCoordinates(latitude, longitude);
  locationAccuracy.textContent = accuracy ? `Accuracy: ±${accuracy} meters` : 'Waiting for GPS';
  batteryValue.textContent = battery ? `${battery}%` : '--';
  if (dashboardLocation) {
    dashboardLocation.textContent = `📍 ${address || 'Current GPS Location'}`;
  }
  if (source === 'device') {
    systemStatus.textContent = 'Live GPS location active';
  }
  if (typeof renderContacts === 'function') {
    renderContacts();
  }
}

async function reverseGeocode(latitude, longitude) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`);
    if (!response.ok) return 'Current GPS location';
    const result = await response.json();
    return result.display_name || 'Current GPS location';
  } catch (error) {
    console.warn('Reverse geocoding unavailable:', error.message);
    return 'Current GPS location';
  }
}

function requestLocationUpdate() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(state.location);
      }
    };
    setTimeout(() => {
      if (!settled) {
        systemStatus.textContent = 'Location request timed out. Try again with GPS enabled.';
        finish();
      }
    }, 15000);

    if (!navigator.geolocation) {
      systemStatus.textContent = 'Geolocation is not supported in this browser.';
      finish();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      state.location = {
        latitude,
        longitude,
        address: await reverseGeocode(latitude, longitude),
        accuracy: Math.round(accuracy || 8),
        battery: 67,
        source: 'device'
      };
      updateLocationDisplay();
      systemStatus.textContent = 'Live location updated';
      updateTime.textContent = 'just now';
      startLiveLocationTracking();
        finish();
    },
    (error) => {
      console.warn('Location error:', error.message);
      const reason = error.code === 1
        ? 'Location permission was denied. Allow location access in the browser.'
        : error.code === 2
          ? 'Your device could not determine a location. Turn on GPS or Wi-Fi location.'
          : 'Location request timed out. Try again outdoors or check device location settings.';
      systemStatus.textContent = reason;
      finish();
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 10000
    }
    );
  });
}

function startLiveLocationTracking() {
  if (!navigator.geolocation || state.locationWatchId !== null) return;
  state.locationWatchId = navigator.geolocation.watchPosition(async (position) => {
    const { latitude, longitude, accuracy } = position.coords;
    state.location = {
      ...state.location,
      latitude,
      longitude,
      address: await reverseGeocode(latitude, longitude),
      accuracy: Math.round(accuracy || 0),
      source: 'device',
      updatedAt: new Date().toISOString()
    };
    updateLocationDisplay();
    updateTime.textContent = 'just now';
    systemStatus.textContent = 'Live GPS location active';
    postApi('/api/location/update', { location: state.location }).catch((error) => {
      console.warn('Live location sync unavailable:', error.message);
    });
  }, (error) => {
    console.warn('Live location error:', error.message);
    systemStatus.textContent = 'Live location paused. Check device permissions.';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

async function postApi(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, ...(body || {}) })
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

function getLocationLink() {
  const { latitude, longitude } = state.location;
  return latitude === null || longitude === null
    ? 'Location unavailable'
    : `https://maps.google.com/?q=${latitude},${longitude}`;
}

function getEmergencyMessage() {
  return `NARI SURAKSHA SOS: ${state.profile?.name || 'The user'} may need assistance. Live location: ${getLocationLink()}`;
}

function updateCallStatus(message) {
  systemStatus.textContent = message;
  const callStatus = document.getElementById('callStatus');
  if (callStatus) {
    callStatus.textContent = message;
    callStatus.hidden = false;
  }
}

async function callSelectedContact() {
  const contact = trustedContacts.find((item) => item.id === state.selectedContactId) || trustedContacts[0];
  if (!contact) {
    updateCallStatus('Add a trusted contact before making an emergency call.');
    setScreen('contacts');
    return;
  }

  if (!/^\+?\d{10,15}$/.test(contact.phone.replace(/\D/g, ''))) {
    updateCallStatus(`Add a valid phone number for ${contact.name} before calling.`);
    return;
  }

  updateCallStatus(`Calling ${contact.name}...`);
  try {
    const result = await postApi('/api/call/contact', {
      contactId: contact.id,
      contact
    });
    if (result.call?.status === 'calling') {
      updateCallStatus(`Twilio started a call to ${contact.name}.`);
    } else if (result.call?.status === 'not_configured') {
      updateCallStatus('Calling unavailable: configure the Twilio Voice settings on the server.');
    } else {
      updateCallStatus(`Call to ${contact.name} failed: ${result.call?.error || 'Twilio did not start the call.'}`);
    }
  } catch (error) {
    updateCallStatus(`Calling unavailable: ${error.message}`);
  }
}

async function openEmergencyShare(message) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'NARI SURAKSHA SOS', text: message });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.warn('Native share unavailable:', error.message);
    }
  }

  try {
    await navigator.clipboard?.writeText(message);
  } catch (error) {
    console.warn('Clipboard unavailable:', error.message);
  }
  systemStatus.textContent = 'Emergency message copied. Paste it into SMS or WhatsApp.';
}

function renderContacts() {
  const contactList = document.getElementById('trustedContactsList');
  const contactDashboard = document.getElementById('contactDashboard');

  const markup = trustedContacts
    .map(
      (contact) => `
        <div class="contact-item ${contact.id === state.selectedContactId ? 'selected' : ''}" data-contact-id="${contact.id}">
          <div class="contact-main">
            <div class="contact-badge">${contact.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</div>
            <div class="contact-meta">
              <strong>${contact.name}</strong>
              <span>${contact.relation} • ${contact.phone}</span>
            </div>
          </div>
          <div class="contact-actions">
            <span class="contact-status">${contact.id === state.selectedContactId ? 'Selected' : contact.status}</span>
            ${contact.id === state.selectedContactId ? `
              <a class="contact-send" data-contact-action="sms" href="sms:${contact.phone.replace(/\s/g, '')}?body=${encodeURIComponent(getEmergencyMessage())}">SMS</a>
              <a class="contact-send whatsapp" data-contact-action="whatsapp" href="https://wa.me/${contact.phone.replace(/\D/g, '')}?text=${encodeURIComponent(getEmergencyMessage())}" target="_blank" rel="noopener">WhatsApp</a>
            ` : ''}
          </div>
        </div>
      `
    )
    .join('');

  contactList.innerHTML = markup;
  contactDashboard.innerHTML = markup;
  const selectedContact = trustedContacts.find((contact) => contact.id === state.selectedContactId);
  if (selectedContactLabel) selectedContactLabel.textContent = selectedContact?.name || 'None selected';
  document.querySelectorAll('[data-contact-id]').forEach((item) => {
    item.addEventListener('click', () => {
      state.selectedContactId = item.dataset.contactId;
      renderContacts();
      systemStatus.textContent = `Selected ${trustedContacts.find((contact) => contact.id === state.selectedContactId).name}`;
    });
  });
  document.querySelectorAll('[data-contact-action]').forEach((action) => {
    action.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (action.dataset.contactAction !== 'sms') {
        systemStatus.textContent = 'Opening WhatsApp for the selected contact';
        return;
      }

      event.preventDefault();
      systemStatus.textContent = 'Sending SMS through the emergency server...';
      const result = await handleEmergencyStart();
      const smsDelivery = result?.deliveries?.[0]?.sms;
      if (smsDelivery?.status !== 'sent') {
        systemStatus.textContent = smsDelivery?.error
          ? 'Server SMS failed. Opening your phone\'s SMS composer...'
          : 'Server SMS is not configured. Opening your phone\'s SMS composer...';
        window.location.href = action.href;
        return;
      }

      systemStatus.textContent = `SMS sent to ${selectedContact.name}.`;
      return;
    });
  });
}

function renderHistory() {
  const historyList = document.getElementById('historyList');
  historyList.innerHTML = emergencyHistory
    .map(
      (event) => `
        <div class="history-item">
          <div class="history-main">
            <div class="contact-badge">⚑</div>
            <div class="history-meta">
              <strong>${event.title}</strong>
              <span>${event.time}</span>
            </div>
          </div>
          <span>${event.detail}</span>
        </div>
      `
    )
    .join('');
}

function setScreen(screen) {
  state.currentScreen = screen;
  tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.screen === screen));
  screens.forEach((item) => item.classList.toggle('active', item.id === `screen-${screen}`));
}

function showWizardStep(step) {
  state.wizardStep = step;
  wizardSteps.forEach((panel) => {
    panel.classList.toggle('active', Number(panel.dataset.step) === step);
  });

  wizardPrev.classList.toggle('hidden', step === 1);
  wizardNext.textContent = step === 3 ? 'Finish Setup' : 'Next';
}

function completeProfileSetup(profile) {
  state.profile = profile;
  localStorage.setItem('nariProfileV1', JSON.stringify(state.profile));
  onboardingOverlay.classList.remove('visible');
  updateProfileDisplay();
  systemStatus.textContent = 'Your profile is secured';
  startLiveLocationTracking();
}

function handleWizardNext() {
  if (state.wizardStep < 3) {
    showWizardStep(state.wizardStep + 1);
    return;
  }

  const profile = {
    userId,
    name: document.getElementById('profileName').value.trim(),
    phone: document.getElementById('profilePhone').value.trim(),
    email: document.getElementById('profileEmail').value.trim(),
    bloodGroup: document.getElementById('profileBlood').value.trim(),
    trustedContacts,
    location: state.location.latitude === null ? null : state.location
  };
  if (!profile.name || !profile.phone || !profile.email) {
    systemStatus.textContent = 'Enter your name, mobile number, and email to continue.';
    showWizardStep(1);
    return;
  }

  postApi('/api/profile', profile)
    .then((result) => {
      completeProfileSetup(result.user || profile);
    })
    .catch((error) => {
      console.warn('Profile save failed, falling back to local-only mode:', error.message);
      completeProfileSetup(profile);
      systemStatus.textContent = 'Your profile is secured locally. Start the API server for cloud sync.';
    });
}

function handleWizardPrevious() {
  showWizardStep(Math.max(1, state.wizardStep - 1));
}

async function handleEmergencyStart(options = {}) {
  if (state.location.latitude === null || state.location.longitude === null) {
    systemStatus.textContent = 'Getting your current location before sending SOS...';
    await requestLocationUpdate();
  }
  if (state.location.latitude === null || state.location.longitude === null) {
    systemStatus.textContent = 'SOS not sent. Enable location permission and try again.';
    return;
  }
  if (!state.selectedContactId) {
    systemStatus.textContent = 'Select a trusted contact before sending SOS.';
    setScreen('contacts');
    return;
  }

  state.emergencyActive = true;
  state.emergencyStatus = 'Emergency active';
  emergencyStatusLabel.textContent = 'Emergency active';
  statusBadge.className = 'status-badge alert';
  statusBadge.textContent = 'SOS Active';
  systemStatus.textContent = 'Emergency mode enabled';
  updateTime.textContent = 'just now';

  emergencyHistory.unshift({
    title: 'Emergency Alert Sent',
    time: 'Now',
    detail: 'Live location and notification sent to trusted contacts',
  });

  renderHistory();

  try {
    const result = await postApi('/api/sos/trigger', {
      source: 'web-demo',
      location: state.location,
      contactId: state.selectedContactId,
      contact: trustedContacts.find((contact) => contact.id === state.selectedContactId)
    });
    const delivery = result.deliveries[0];
    const delivered = [delivery.sms.status, delivery.whatsapp.status, delivery.call.status, delivery.police?.call?.status]
      .filter((status) => status === 'sent' || status === 'calling').length;
    const smsError = delivery.sms.status === 'failed' ? ` SMS error: ${delivery.sms.error}` : '';
    const whatsappError = delivery.whatsapp.status === 'failed' ? ` WhatsApp error: ${delivery.whatsapp.error}` : '';
    const callStatus = [delivery.call.status, delivery.police?.call?.status].includes('calling') ? ' Voice call attempts started.' : '';
    const callError = delivery.call.status === 'failed' ? ` Voice error: ${delivery.call.error}` : '';
    systemStatus.textContent = delivered
      ? `Alert sent to ${delivery.contact} by ${delivered} channel${delivered === 1 ? '' : 's'}.${callStatus}`
      : `Alert created for ${delivery.contact}.${smsError || whatsappError || callError || ' Configure Twilio SMS/Voice/WhatsApp settings.'}`;
    await openEmergencyShare(result.alert.message);
    return result;
  } catch (error) {
    console.warn('SOS API unavailable:', error.message);
    systemStatus.textContent = `SOS was not sent: ${error.message}`;
    return null;
  }
}

async function shareLocation() {
  if (state.location.latitude === null) {
    systemStatus.textContent = 'Getting your current location...';
    await requestLocationUpdate();
  }
  if (state.location.latitude === null || state.location.longitude === null) {
    systemStatus.textContent = 'Enable location permission before sharing';
    return;
  }
  const selectedContact = trustedContacts.find((contact) => contact.id === state.selectedContactId);
  if (!selectedContact) {
    systemStatus.textContent = 'Select a trusted contact before sharing';
    return;
  }
  updateTime.textContent = 'just now';
  systemStatus.textContent = 'Location shared to trusted contacts';
  const locationMessage = `NARI SURAKSHA live location: ${getLocationLink()}`;

  try {
    const result = await postApi('/api/location/share', {
      location: state.location,
      contactId: state.selectedContactId,
      contact: selectedContact
    });
    state.location = {
      ...state.location,
      ...result.location,
      source: 'device'
    };
    updateLocationDisplay();
    updateTime.textContent = 'just now';
    const delivered = result.delivery
      ? [result.delivery.sms.status, result.delivery.whatsapp.status].filter((status) => status === 'sent').length
      : 0;
    if (delivered) {
      systemStatus.textContent = `Live location sent to ${result.contact} by ${delivered} channel${delivered === 1 ? '' : 's'}`;
    } else {
      const smsError = result.delivery?.sms?.error || 'SMS unavailable';
      const whatsappError = result.delivery?.whatsapp?.error || 'WhatsApp unavailable';
      systemStatus.textContent = `Location delivery failed. SMS: ${smsError}. WhatsApp: ${whatsappError}`;
      const whatsappUrl = `https://wa.me/${selectedContact.phone.replace(/\D/g, '')}?text=${encodeURIComponent(locationMessage)}`;
      window.open(whatsappUrl, '_blank', 'noopener');
    }
  } catch (error) {
    console.warn('Location API unavailable:', error.message);
    systemStatus.textContent = `Location not sent to ${selectedContact.name}. Start the notification server.`;
  }
  if (!apiBase) await openEmergencyShare(locationMessage);
}

function handleSafetyTimer() {
  state.timerActive = true;
  systemStatus.textContent = 'Safety timer running';
  emergencyStatusLabel.textContent = 'Timer active';
  statusBadge.className = 'status-badge success';
  statusBadge.textContent = 'Timer';
}

function handleSafeJourney() {
  state.safeJourneyActive = !state.safeJourneyActive;
  const label = state.safeJourneyActive ? 'Safe journey active' : 'Safe journey paused';
  systemStatus.textContent = label;
  emergencyStatusLabel.textContent = label;
  statusBadge.className = state.safeJourneyActive ? 'status-badge success' : 'status-badge neutral';
  statusBadge.textContent = state.safeJourneyActive ? 'Journey' : 'Safe';
}

function bindEvents() {
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => setScreen(tab.dataset.screen));
  });

  const themeToggleButton = document.getElementById('themeToggle');
  if (themeToggleButton) {
    themeToggleButton.addEventListener('click', () => {
      document.body.classList.toggle('light');
    });
  }

  const enableLocationButton = document.getElementById('enableLocationButton');
  if (enableLocationButton) {
    enableLocationButton.addEventListener('click', () => {
      systemStatus.textContent = 'Requesting your live location...';
      startLiveLocationTracking();
      requestLocationUpdate();
    });

  }

  document.getElementById('sosButton').addEventListener('click', () => {
    handleEmergencyStart();
  });
  document.querySelectorAll('[data-action="trigger-sos"]').forEach((button) => {
    button.addEventListener('click', handleEmergencyStart);
  });
  document.getElementById('sendSelectedAlert').addEventListener('click', handleEmergencyStart);
  document.getElementById('startJourney').addEventListener('click', handleSafeJourney);

  document.querySelectorAll('[data-action="safety-timer"]').forEach((button) => {
    button.addEventListener('click', handleSafetyTimer);
  });

  document.querySelectorAll('[data-action="safe-journey"]').forEach((button) => {
    button.addEventListener('click', handleSafeJourney);
  });

  document.querySelectorAll('[data-action="share-location"]').forEach((button) => {
    button.addEventListener('click', shareLocation);
  });

  document.querySelectorAll('[data-action="emergency-call"]').forEach((button) => {
    button.addEventListener('click', callSelectedContact);
  });

  document.getElementById('doubleTapEmergency').checked = state.doubleTapEmergency;
  document.getElementById('doubleTapEmergency').addEventListener('change', (event) => {
    state.doubleTapEmergency = event.target.checked;
    localStorage.setItem('nariDoubleTapEmergency', String(state.doubleTapEmergency));
    systemStatus.textContent = state.doubleTapEmergency
      ? 'Two-tap emergency mode enabled'
      : 'Two-tap emergency mode disabled';
  });
  document.getElementById('lockAppButton').addEventListener('click', () => setAppLocked(true));
  document.getElementById('unlockAppButton').addEventListener('click', () => setAppLocked(false));
  document.addEventListener('click', handleDoubleTap);

  document.querySelectorAll('[data-sharing]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-sharing]').forEach((option) => option.classList.remove('active'));
      button.classList.add('active');
      systemStatus.textContent = `Location sharing: ${button.textContent}`;
    });
  });

  document.getElementById('exportHistory').addEventListener('click', () => {
    const file = new Blob([JSON.stringify(emergencyHistory, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = 'nari-suraksha-history.json';
    link.click();
    URL.revokeObjectURL(link.href);
    systemStatus.textContent = 'Emergency history exported';
  });

  document.getElementById('openLiveLocation').addEventListener('click', () => {
    const { latitude, longitude } = state.location;
    window.open(`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`, '_blank', 'noopener');
  });

  document.getElementById('callContact').addEventListener('click', () => {
    callSelectedContact();
  });

  document.getElementById('navigateToLocation').addEventListener('click', () => {
    const { latitude, longitude } = state.location;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`, '_blank', 'noopener');
  });

  document.querySelectorAll('[data-action="add-contact"]').forEach((button) => {
    button.addEventListener('click', () => {
      contactModal.classList.add('visible');
      contactModal.setAttribute('aria-hidden', 'false');
      document.getElementById('contactName').focus();
    });
  });

  document.getElementById('cancelContact').addEventListener('click', closeContactModal);

  const handleSaveContact = async (event) => {
    event.preventDefault();
    const contact = {
      id: `contact_${Date.now()}`,
      name: document.getElementById('contactName').value.trim(),
      relation: document.getElementById('contactRelation').value.trim(),
      phone: document.getElementById('contactPhone').value.trim(),
      status: 'Pending verification'
    };
    if (!contact.name || !contact.relation || !contact.phone) {
      systemStatus.textContent = 'Enter the contact name, relation, and phone number.';
      return;
    }

    const normalizedPhone = contact.phone.replace(/\s+/g, '');
    if (!/^\+?[0-9]{10,15}$/.test(normalizedPhone)) {
      systemStatus.textContent = 'Enter a valid phone number for the trusted contact.';
      return;
    }

    systemStatus.textContent = 'Adding contact and sending verification SMS...';

    try {
      const result = await postApi('/api/contacts', contact);
      const savedContact = result.contact || contact;
      trustedContacts.push(savedContact);
      state.selectedContactId = savedContact.id;
      localStorage.setItem('nariTrustedContactsV3', JSON.stringify(trustedContacts));
      renderContacts();
      closeContactModal();
      const sms = result.delivery?.sms || { status: 'not_configured' };
      systemStatus.textContent = sms.status === 'sent'
        ? `${savedContact.name} added. SMS sent successfully.`
        : `${savedContact.name} added locally. SMS needs Twilio credentials to send for real.`;
    } catch (error) {
      console.warn('Contact registration failed, using local-only fallback:', error.message);
      trustedContacts.push(contact);
      state.selectedContactId = contact.id;
      localStorage.setItem('nariTrustedContactsV3', JSON.stringify(trustedContacts));
      renderContacts();
      closeContactModal();
      systemStatus.textContent = `${contact.name} was added locally. Add Twilio credentials to enable SMS.`;
    }
  };

  document.getElementById('saveContactButton').addEventListener('click', handleSaveContact);
  document.getElementById('contactForm').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSaveContact(event);
  });

  wizardPrev.addEventListener('click', handleWizardPrevious);
  wizardNext.addEventListener('click', handleWizardNext);
}

function closeContactModal() {
  contactModal.classList.remove('visible');
  contactModal.setAttribute('aria-hidden', 'true');
  document.getElementById('contactForm').reset();
}

renderContacts();
renderHistory();
showWizardStep(1);
updateLocationDisplay();
updateProfileDisplay();
if (state.profile) {
  onboardingOverlay.classList.remove('visible');
  postApi('/api/profile', state.profile).catch((error) => {
    console.warn('Profile sync unavailable:', error.message);
  });
  startLiveLocationTracking();
}
bindEvents();
setAppLocked(state.appLocked);
