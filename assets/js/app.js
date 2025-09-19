(function () {
  const hasLeaflet = typeof window !== 'undefined' && typeof window.L !== 'undefined';

  const DEFAULT_VIEW = {
    center: [35.6678, -105.9644],
    zoom: 12
  };
  const MAP_BOUNDS = hasLeaflet
    ? L.latLngBounds(
        [35.56, -106.15],
        [35.81, -105.8]
      )
    : null;
  const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const NOMINATIM_HEADERS = {
    'Accept': 'application/json'
  };
  const SANTA_FE_CENTER = hasLeaflet ? L.latLng(35.686975, -105.937799) : null;
  const NOMINATIM_EMAIL = 'info@jackforchange.org';
  const NOMINATIM_PARAMS = {
    format: 'jsonv2',
    addressdetails: '1',
    countrycodes: 'us',
    limit: '6',
    'accept-language': 'en'
  };

  const AUTOCOMPLETE_CONFIG = {
    minQueryLength: 3,
    maxSuggestions: 6,
    remoteLimit: 10,
    cacheLimit: 24,
    maxLocalEntries: 240
  };

  const supportsAbortController = typeof window !== 'undefined'
    && typeof window.AbortController === 'function';

  function normalizeText(value) {
    try {
      return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    } catch (error) {
      return value.toLowerCase();
    }
  }

  function tokenizeNormalizedValue(normalized) {
    return normalized.split(/[^a-z0-9]+/).filter(Boolean);
  }

  class AutocompleteEngine {
    constructor(options) {
      this.remoteFetcher = options.remoteFetcher;
      this.minQueryLength = options.minQueryLength;
      this.maxSuggestions = options.maxSuggestions;
      this.cacheLimit = options.cacheLimit;
      this.maxLocalEntries = options.maxLocalEntries;
      this.distanceCenter = options.distanceCenter;
      this.isInsideDistrict = options.isInsideDistrict;

      this.cache = new Map();
      this.localIndex = new Map();
      this.localOrder = [];
      this.currentAbortController = null;
      this.abortSupported = supportsAbortController;
    }

    normalize(value) {
      return normalizeText(value);
    }

    tokenize(normalized) {
      return tokenizeNormalizedValue(normalized);
    }

    buildKey(candidate) {
      const lat = candidate.latlng ? candidate.latlng.lat.toFixed(6) : 'unknown';
      const lng = candidate.latlng ? candidate.latlng.lng.toFixed(6) : 'unknown';
      return `${candidate.primary.toLowerCase()}|${candidate.secondary || ''}|${lat}|${lng}`;
    }

    prepareCandidate(raw) {
      const searchable = `${raw.primary || ''} ${raw.secondary || ''}`.trim();
      const normalized = this.normalize(searchable);
      const tokens = this.tokenize(normalized);
      const primaryNormalized = raw.primary ? this.normalize(raw.primary) : '';
      const primaryTokens = this.tokenize(primaryNormalized);
      const secondaryNormalized = raw.secondary ? this.normalize(raw.secondary) : '';
      const secondaryTokens = this.tokenize(secondaryNormalized);
      const labelNormalized = raw.label ? this.normalize(raw.label) : searchable ? normalized : '';
      const derivedHouseNumber = primaryTokens.length && /^\d+$/.test(primaryTokens[0])
        ? primaryTokens[0]
        : null;

      const candidate = {
        ...raw,
        searchable,
        searchNormalized: normalized,
        searchTokens: tokens,
        insideDistrict: null,
        distanceMeters: null,
        primaryNormalized,
        primaryTokens,
        secondaryNormalized,
        secondaryTokens,
        labelNormalized,
        houseNumber: raw.houseNumber || derivedHouseNumber || null
      };

      if (raw.latlng && this.distanceCenter) {
        try {
          candidate.distanceMeters = raw.latlng.distanceTo(this.distanceCenter);
        } catch (error) {
          candidate.distanceMeters = null;
        }
      }

      if (raw.latlng && typeof this.isInsideDistrict === 'function') {
        try {
          const value = this.isInsideDistrict(raw.latlng);
          if (typeof value === 'boolean') {
            candidate.insideDistrict = value;
          }
        } catch (error) {
          candidate.insideDistrict = null;
        }
      }

      return candidate;
    }

    cacheResult(normalizedQuery, candidates) {
      if (!normalizedQuery) {
        return;
      }

      if (!this.cache.has(normalizedQuery) && this.cache.size >= this.cacheLimit) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) {
          this.cache.delete(oldestKey);
        }
      }

      this.cache.set(normalizedQuery, candidates);
    }

    indexCandidates(candidates) {
      candidates.forEach((candidate) => {
        const key = this.buildKey(candidate);
        if (this.localIndex.has(key)) {
          return;
        }

        this.localIndex.set(key, candidate);
        this.localOrder.push(key);
      });

      while (this.localOrder.length > this.maxLocalEntries) {
        const oldestKey = this.localOrder.shift();
        if (oldestKey) {
          this.localIndex.delete(oldestKey);
        }
      }
    }

    scoreCandidate(queryTokens, candidate, queryNormalized, rawQuery) {
      if (!Array.isArray(queryTokens) || !queryTokens.length) {
        return 0;
      }

      const candidateTokens = candidate.searchTokens || [];
      const primaryTokens = candidate.primaryTokens || [];
      const secondaryTokens = candidate.secondaryTokens || [];
      const primaryNormalized = candidate.primaryNormalized || '';
      const searchNormalized = candidate.searchNormalized || '';
      const labelNormalized = candidate.labelNormalized || '';
      const queryNormalizedValue = queryNormalized || '';
      const rawQueryValue = rawQuery || '';
      const numericTokens = queryTokens.filter((token) => /^\d+$/.test(token));
      const trimmedRawQuery = rawQueryValue.trim();
      const firstNumericToken = numericTokens[0] || '';
      const expectsHouseNumber = /^\d+\s+/.test(trimmedRawQuery)
        || (firstNumericToken
          && firstNumericToken.length <= 4
          && trimmedRawQuery.startsWith(firstNumericToken)
          && trimmedRawQuery.length > firstNumericToken.length);
      const expectsPostalCode = numericTokens.some((token) => token.length >= 5
        || (!expectsHouseNumber && token.length >= 4));
      const normalizedPostcode = candidate.postcode
        ? String(candidate.postcode).replace(/\D+/g, '')
        : null;
      let score = 0;
      let matchedTokens = 0;
      let sequentialMatches = 0;
      let lastMatchPosition = -1;

      queryTokens.forEach((token, tokenIndex) => {
        if (!token) {
          return;
        }

        const isNumeric = /^\d+$/.test(token);
        const looksLikeZip = expectsPostalCode && token.length >= 4 && (!expectsHouseNumber || tokenIndex > 0);
        const exactPrimaryIndex = primaryTokens.indexOf(token);
        const prefixPrimaryIndex = exactPrimaryIndex !== -1
          ? exactPrimaryIndex
          : primaryTokens.findIndex((part) => part.startsWith(token));
        const exactSecondaryIndex = secondaryTokens.indexOf(token);
        const prefixSecondaryIndex = exactSecondaryIndex !== -1
          ? exactSecondaryIndex
          : secondaryTokens.findIndex((part) => part.startsWith(token));
        const exactAnyIndex = candidateTokens.indexOf(token);
        const prefixAnyIndex = exactAnyIndex !== -1
          ? exactAnyIndex
          : candidateTokens.findIndex((part) => part.startsWith(token));

        let tokenScore = 0;
        let matchPosition = -1;

        if (isNumeric) {
          if (looksLikeZip && normalizedPostcode) {
            if (normalizedPostcode === token) {
              matchPosition = primaryTokens.length + secondaryTokens.length + 1;
              tokenScore += 18;
            } else if (normalizedPostcode.startsWith(token)) {
              matchPosition = primaryTokens.length + secondaryTokens.length + 1;
              tokenScore += 12;
            }
          }

          if (matchPosition === -1 && primaryTokens.length && primaryTokens[0].startsWith(token)) {
            matchPosition = 0;
            tokenScore += primaryTokens[0] === token ? 20 : 16;
          } else if (matchPosition === -1 && prefixAnyIndex !== -1) {
            matchPosition = prefixAnyIndex;
            tokenScore += 8;
          } else if (matchPosition === -1 && searchNormalized.includes(token)) {
            tokenScore += 6;
          } else if (matchPosition === -1) {
            tokenScore -= 8;
          }
        } else {
          if (exactPrimaryIndex !== -1) {
            matchPosition = exactPrimaryIndex;
            tokenScore += 13;
          } else if (prefixPrimaryIndex !== -1) {
            matchPosition = prefixPrimaryIndex;
            tokenScore += 10;
          } else if (exactAnyIndex !== -1) {
            matchPosition = exactAnyIndex;
            tokenScore += 9;
          } else if (prefixAnyIndex !== -1) {
            matchPosition = prefixAnyIndex;
            tokenScore += 6;
          } else if (exactSecondaryIndex !== -1) {
            matchPosition = primaryTokens.length + exactSecondaryIndex;
            tokenScore += 5;
          } else if (prefixSecondaryIndex !== -1) {
            matchPosition = primaryTokens.length + prefixSecondaryIndex;
            tokenScore += 3;
          } else if (searchNormalized.includes(token)) {
            tokenScore += 2;
          } else {
            tokenScore -= 4;
          }
        }

        if (matchPosition !== -1) {
          matchedTokens += 1;

          if (matchPosition > lastMatchPosition) {
            sequentialMatches += 1;
            lastMatchPosition = matchPosition;
            tokenScore += 1.5;
          }
        }

        score += tokenScore;
      });

      if (matchedTokens < queryTokens.length) {
        score -= (queryTokens.length - matchedTokens) * 3;
      }

      if (matchedTokens) {
        score += matchedTokens * 2;
      }

      if (sequentialMatches >= 2) {
        score += sequentialMatches * 1.5;
      }

      if (queryNormalizedValue.length >= 4) {
        if (primaryNormalized.startsWith(queryNormalizedValue)) {
          score += 10;
        } else if (searchNormalized.startsWith(queryNormalizedValue)) {
          score += 6;
        } else if (labelNormalized.startsWith(queryNormalizedValue)) {
          score += 4;
        }
      }

      if (rawQueryValue.length >= 4) {
        const rawLower = rawQueryValue.toLowerCase();
        if (candidate.primary && candidate.primary.toLowerCase().startsWith(rawLower)) {
          score += 6;
        } else if (candidate.label && candidate.label.toLowerCase().startsWith(rawLower)) {
          score += 3;
        }
      }

      if (expectsHouseNumber && !candidate.houseNumber) {
        score -= 6;
      }

      if (candidateTokens.length) {
        const extraTokens = Math.max(candidateTokens.length - queryTokens.length, 0);
        if (extraTokens) {
          score -= extraTokens * 0.4;
        }
      }

      if (typeof candidate.distanceMeters === 'number') {
        const normalizedDistance = Math.min(candidate.distanceMeters, 6000);
        const proximityBoost = Math.max(0, 1 - normalizedDistance / 6000);
        score += proximityBoost * 5;
      }

      if (candidate.insideDistrict === true) {
        score += 6;
      } else if (candidate.insideDistrict === false) {
        score -= 2;
      }

      return score;
    }

    scoreCandidates(candidates, queryTokens, queryNormalized, rawQuery) {
      const scored = candidates.map((candidate) => ({
        candidate,
        score: this.scoreCandidate(queryTokens, candidate, queryNormalized, rawQuery)
      }));

      const positive = scored
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      if (positive.length >= this.maxSuggestions) {
        return positive.slice(0, this.maxSuggestions);
      }

      if (positive.length) {
        const remainder = scored
          .filter((entry) => entry.score <= 0)
          .sort((a, b) => b.score - a.score);
        return [...positive, ...remainder].slice(0, this.maxSuggestions);
      }

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxSuggestions);
    }

    searchLocalMatches(queryTokens, queryNormalized, rawQuery) {
      if (!this.localOrder.length) {
        return [];
      }

      const candidates = this.localOrder
        .map((key) => this.localIndex.get(key))
        .filter(Boolean);

      return this.scoreCandidates(candidates, queryTokens, queryNormalized, rawQuery);
    }

    mergeMatches(localMatches, remoteMatches) {
      const combined = [...localMatches, ...remoteMatches];
      combined.sort((a, b) => b.score - a.score);

      const seen = new Set();
      const result = [];

      for (const entry of combined) {
        const key = this.buildKey(entry.candidate);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(entry);

        if (result.length >= this.maxSuggestions) {
          break;
        }
      }

      return result;
    }

    preview(rawQuery) {
      const trimmed = rawQuery.trim();
      const normalized = this.normalize(trimmed);
      const tokens = this.tokenize(normalized);
      const localMatches = trimmed.length >= this.minQueryLength
        ? this.searchLocalMatches(tokens, normalized, trimmed)
        : [];

      return {
        rawQuery: trimmed,
        normalized,
        tokens,
        localMatches,
        localCandidates: localMatches.map((entry) => entry.candidate)
      };
    }

    fetchRemote(rawQuery, normalized, tokens) {
      if (this.cache.has(normalized)) {
        const cached = this.cache.get(normalized) || [];
        return Promise.resolve(this.scoreCandidates(cached, tokens, normalized, rawQuery));
      }

      let controller = null;
      if (this.abortSupported) {
        if (this.currentAbortController) {
          this.currentAbortController.abort();
        }

        controller = new AbortController();
        this.currentAbortController = controller;
      }

      const remoteOptions = controller ? { signal: controller.signal } : {};

      return this.remoteFetcher(rawQuery, remoteOptions)
        .then((rawList) => rawList.map((item) => this.prepareCandidate(item)))
        .then((prepared) => {
          this.cacheResult(normalized, prepared);
          this.indexCandidates(prepared);
          return this.scoreCandidates(prepared, tokens, normalized, rawQuery);
        })
        .catch((error) => {
          if (controller && error && error.name === 'AbortError') {
            return [];
          }
          throw error;
        })
        .finally(() => {
          if (controller && this.currentAbortController === controller) {
            this.currentAbortController = null;
          }
        });
    }

    search(rawQuery, previewState) {
      const preview = previewState || this.preview(rawQuery);
      const { rawQuery: trimmed, normalized, tokens, localMatches } = preview;

      if (trimmed.length < this.minQueryLength) {
        return Promise.resolve({
          suggestions: [],
          localCandidates: [],
          usedRemote: false
        });
      }

      if (localMatches.length >= this.maxSuggestions) {
        return Promise.resolve({
          suggestions: localMatches.slice(0, this.maxSuggestions).map((entry) => entry.candidate),
          localCandidates: localMatches.map((entry) => entry.candidate),
          usedRemote: false
        });
      }

      return this.fetchRemote(trimmed, normalized, tokens)
        .then((remoteMatches) => {
          const merged = this.mergeMatches(localMatches, remoteMatches);
          return {
            suggestions: merged.map((entry) => entry.candidate),
            localCandidates: localMatches.map((entry) => entry.candidate),
            usedRemote: true,
            remoteCount: remoteMatches.length
          };
        })
        .catch((error) => {
          if (error && error.name === 'AbortError') {
            return {
              suggestions: localMatches.map((entry) => entry.candidate),
              localCandidates: localMatches.map((entry) => entry.candidate),
              usedRemote: false,
              aborted: true
            };
          }

          throw error;
        });
    }
  }

  const mapContainer = hasLeaflet ? document.getElementById('map') : null;
  const map = hasLeaflet && mapContainer
    ? L.map(mapContainer, {
        zoomControl: true,
        scrollWheelZoom: true,
        maxBounds: MAP_BOUNDS ? MAP_BOUNDS.pad(0.15) : undefined,
        maxBoundsViscosity: 0.8
      }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom)
    : null;

  if (map) {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  const pageHeader = document.querySelector('.page-header');
  const navToggle = document.getElementById('nav-toggle');
  const navLinksList = document.getElementById('nav-links');
  const addressInput = document.getElementById('address-input');
  const resultsList = document.getElementById('search-results');
  const statusEl = document.getElementById('lookup-status');
  const resetButton = document.getElementById('reset-view');

  let districtData = null;
  let districtLayer = null;
  let resultMarker = null;
  let suggestions = [];
  let highlightedIndex = -1;
  let searchDebounceTimer = null;
  let lastSearchToken = 0;

  const autocompleteEngine = map
    ? new AutocompleteEngine({
        remoteFetcher: (query, options = {}) => {
          const trimmed = query.replace(/\s+/g, ' ').trim();
          const params = new URLSearchParams({ ...NOMINATIM_PARAMS });
          params.set('viewbox', '-106.15,35.82,-105.85,35.55');
          params.set('bounded', '1');
          params.set('email', NOMINATIM_EMAIL);
          params.set('limit', String(AUTOCOMPLETE_CONFIG.remoteLimit));
          params.set('q', `${trimmed}, Santa Fe, NM`);

          return fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
            headers: NOMINATIM_HEADERS,
            signal: options.signal
          })
            .then((response) => {
              if (!response.ok) {
                throw new Error(`Lookup failed (${response.status})`);
              }
              return response.json();
            })
            .then((data) => data.map(parseNominatimResult))
            .then((list) => {
              if (!MAP_BOUNDS) {
                return list;
              }
              return list.filter((item) => item && MAP_BOUNDS.contains(item.latlng));
            });
        },
        minQueryLength: AUTOCOMPLETE_CONFIG.minQueryLength,
        maxSuggestions: AUTOCOMPLETE_CONFIG.maxSuggestions,
        cacheLimit: AUTOCOMPLETE_CONFIG.cacheLimit,
        maxLocalEntries: AUTOCOMPLETE_CONFIG.maxLocalEntries,
        distanceCenter: SANTA_FE_CENTER,
        isInsideDistrict: (latlng) => isPointInsideDistrict(latlng)
      })
    : null;

  function setNavMenu(open) {
    if (!pageHeader || !navToggle || !navLinksList) {
      return;
    }
    pageHeader.classList.toggle('nav-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
  }

  function bindNavigation() {
    if (!pageHeader || !navToggle || !navLinksList) {
      return;
    }

    navToggle.addEventListener('click', () => {
      const isOpen = pageHeader.classList.contains('nav-open');
      setNavMenu(!isOpen);
    });

    navLinksList.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setNavMenu(false));
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) {
        setNavMenu(false);
      }
    });

    document.addEventListener('click', (event) => {
      if (!pageHeader.classList.contains('nav-open')) {
        return;
      }

      if (navToggle.contains(event.target) || navLinksList.contains(event.target)) {
        return;
      }

      setNavMenu(false);
    });
  }

  function setStatus(state, message) {
    if (!statusEl) {
      return;
    }

    statusEl.classList.remove('status-success', 'status-error', 'status-neutral');
    statusEl.classList.add(`status-${state}`);
    statusEl.textContent = message;
  }

  function buildIcon(state) {
    if (!hasLeaflet) {
      return null;
    }

    const className = state === 'success'
      ? 'marker-result success'
      : state === 'error'
        ? 'marker-result error'
        : 'marker-result neutral';

    return L.divIcon({
      html: `<div class="${className}"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      className: ''
    });
  }

  function ensureMarker(latlng, state) {
    if (!map || !hasLeaflet) {
      return;
    }

    if (!resultMarker) {
      resultMarker = L.marker(latlng, {
        icon: buildIcon(state),
        draggable: true,
        autoPan: true
      }).addTo(map);

      resultMarker.on('moveend', () => {
        const draggedLatLng = resultMarker.getLatLng();
        evaluateLocation(draggedLatLng, {
          label: 'Dragged marker location',
          panTo: false
        });
      });
    } else {
      resultMarker.setLatLng(latlng);
    }

    resultMarker.setIcon(buildIcon(state));
  }

  function isPointInsideDistrict(latlng) {
    if (!districtData || typeof turf === 'undefined') {
      return null;
    }

    const point = turf.point([latlng.lng, latlng.lat]);

    return districtData.features.some((feature) => {
      try {
        return turf.booleanPointInPolygon(point, feature);
      } catch (error) {
        console.warn('Unable to evaluate polygon for feature', error);
        return false;
      }
    });
  }

  function evaluateLocation(latlng, options = {}) {
    const { label = 'Selected location', panTo = true, announceState = true } = options;

    if (!map) {
      return;
    }

    if (!districtData) {
      setStatus('error', 'District boundary not loaded yet. Please try again in a moment.');
      return;
    }

    const inside = isPointInsideDistrict(latlng);

    if (inside === null) {
      setStatus('error', 'District boundary not available. Add a valid GeoJSON file at assets/data/district5.geojson.');
      return;
    }

    const state = inside ? 'success' : 'error';
    const message = inside
      ? `${label} is inside District 5.`
      : `${label} is not inside District 5.`;

    if (panTo) {
      const zoomTarget = label === 'Dragged marker location' ? map.getZoom() : Math.max(map.getZoom(), 15);
      map.flyTo(latlng, zoomTarget, { duration: 0.7 });
    }

    ensureMarker(latlng, state);

    if (announceState) {
      setStatus(state, message);
    }
  }

  function hideSuggestions() {
    suggestions = [];
    highlightedIndex = -1;

    if (!resultsList || !addressInput) {
      return;
    }

    resultsList.innerHTML = '';
    resultsList.classList.remove('visible');
    addressInput.setAttribute('aria-expanded', 'false');
    addressInput.removeAttribute('aria-activedescendant');
    addressInput.setAttribute('aria-busy', 'false');
  }

  function renderSuggestions(list) {
    suggestions = list;
    highlightedIndex = -1;

    if (!resultsList || !addressInput) {
      return;
    }

    if (!Array.isArray(list) || list.length === 0) {
      hideSuggestions();
      return;
    }

    const fragment = document.createDocumentFragment();

    list.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      li.id = `suggestion-${index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result-button';
      button.innerHTML = `${item.primary}<span class="search-result-secondary">${item.secondary}</span>`;

      button.addEventListener('click', () => {
        selectSuggestion(index);
      });

      li.appendChild(button);
      fragment.appendChild(li);
    });

    resultsList.innerHTML = '';
    resultsList.appendChild(fragment);
    resultsList.classList.add('visible');
    addressInput.setAttribute('aria-expanded', 'true');
    addressInput.setAttribute('aria-busy', 'false');
  }

  function highlightSuggestion(nextIndex) {
    if (!suggestions.length || !resultsList || !addressInput) {
      return;
    }

    const count = suggestions.length;
    highlightedIndex = (nextIndex + count) % count;

    Array.from(resultsList.children).forEach((child, index) => {
      const isActive = index === highlightedIndex;
      child.classList.toggle('active', isActive);
      child.setAttribute('aria-selected', String(isActive));

      if (isActive) {
        addressInput.setAttribute('aria-activedescendant', child.id);
      }
    });
  }

  function selectSuggestion(index) {
    const suggestion = suggestions[index];
    if (!suggestion) {
      return;
    }

    hideSuggestions();
    addressInput.value = suggestion.primary;
    evaluateLocation(suggestion.latlng, {
      label: suggestion.shortLabel || suggestion.label,
      panTo: true
    });
  }

  function parseNominatimResult(result) {
    if (!hasLeaflet) {
      return null;
    }

    const label = result.display_name;
    const latlng = L.latLng(parseFloat(result.lat), parseFloat(result.lon));

    const address = result.address || {};
    const houseNumber = address.house_number ? String(address.house_number).trim() : null;
    const streetName = address.road
      || address.pedestrian
      || address.cycleway
      || address.footway
      || address.path
      || address.neighbourhood
      || address.suburb;
    const primary = [
      houseNumber,
      streetName
    ].filter(Boolean).join(' ') || label;

    const cityName = address.city || address.town || address.village || address.hamlet || 'Santa Fe';
    const localityPieces = [
      cityName,
      address.state || 'New Mexico',
      address.postcode
    ].filter(Boolean);

    return {
      label,
      primary,
      secondary: localityPieces.join(', '),
      shortLabel: [primary, cityName].filter(Boolean).join(', '),
      latlng,
      houseNumber,
      postcode: address.postcode || null
    };
  }

  function fetchSuggestions(query) {
    if (!autocompleteEngine) {
      return Promise.resolve([]);
    }

    const preview = autocompleteEngine.preview(query);
    const trimmed = preview.rawQuery;
    const searchToken = ++lastSearchToken;

    if (!trimmed) {
      hideSuggestions();
      setStatus('neutral', 'Search for an address to begin.');
      return Promise.resolve([]);
    }

    if (trimmed.length < AUTOCOMPLETE_CONFIG.minQueryLength) {
      hideSuggestions();
      setStatus('neutral', `Keep typing (min. ${AUTOCOMPLETE_CONFIG.minQueryLength} characters).`);
      return Promise.resolve([]);
    }

    const needsRemote = preview.localMatches.length < AUTOCOMPLETE_CONFIG.maxSuggestions;

    if (preview.localCandidates.length) {
      renderSuggestions(preview.localCandidates);
    }

    if (needsRemote) {
      addressInput.setAttribute('aria-busy', 'true');
      if (!preview.localCandidates.length) {
        setStatus('neutral', 'Searching addresses…');
      }
    } else {
      addressInput.setAttribute('aria-busy', 'false');
      setStatus('neutral', 'Select an address to check the district.');
    }

    return autocompleteEngine.search(trimmed, preview)
      .then((result) => {
        if (searchToken !== lastSearchToken) {
          return [];
        }

        const list = result.suggestions || [];

        if (list.length) {
          renderSuggestions(list);
          setStatus('neutral', 'Select an address to check the district.');
        } else {
          hideSuggestions();
          setStatus('error', 'No Santa Fe results found. Try a full street address.');
        }

        addressInput.setAttribute('aria-busy', 'false');
        return list;
      })
      .catch((error) => {
        if (searchToken !== lastSearchToken) {
          return [];
        }

        console.error(error);
        hideSuggestions();
        setStatus('error', 'Address search is temporarily unavailable. Try again in a moment.');
        addressInput.setAttribute('aria-busy', 'false');
        return [];
      });
  }

  function attachSearchHandlers() {
    addressInput.addEventListener('input', () => {
      if (searchDebounceTimer) {
        window.clearTimeout(searchDebounceTimer);
      }

      const query = addressInput.value;
      const trimmed = query.replace(/\s+/g, ' ').trim();

      if (!trimmed) {
        hideSuggestions();
        setStatus('neutral', 'Search for an address to begin.');
        return;
      }

      if (trimmed.length < AUTOCOMPLETE_CONFIG.minQueryLength) {
        hideSuggestions();
        setStatus('neutral', `Keep typing (min. ${AUTOCOMPLETE_CONFIG.minQueryLength} characters).`);
        return;
      }

      const delay = trimmed.length >= 7
        ? 110
        : trimmed.length >= 5
          ? 150
          : 210;

      searchDebounceTimer = window.setTimeout(() => {
        fetchSuggestions(query);
      }, delay);
    });

    addressInput.addEventListener('keydown', (event) => {
      if (!suggestions.length) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          highlightSuggestion(highlightedIndex + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          highlightSuggestion(highlightedIndex - 1);
          break;
        case 'Enter':
          if (highlightedIndex >= 0) {
            event.preventDefault();
            selectSuggestion(highlightedIndex);
          } else if (suggestions.length) {
            event.preventDefault();
            selectSuggestion(0);
          }
          break;
        case 'Escape':
          hideSuggestions();
          break;
        default:
          break;
      }
    });

    addressInput.addEventListener('focus', () => {
      if (suggestions.length) {
        resultsList.classList.add('visible');
        addressInput.setAttribute('aria-expanded', 'true');
      }
    });

    document.addEventListener('click', (event) => {
      if (!resultsList.contains(event.target) && event.target !== addressInput) {
        hideSuggestions();
      }
    });
  }

  function bindMapInteractions() {
    if (!map) {
      return;
    }

    map.on('click', (event) => {
      evaluateLocation(event.latlng, {
        label: 'Selected point on the map'
      });
    });

    if (resultMarker) {
      resultMarker.dragging.enable();
    }
  }

  function loadDistrictLayer() {
    if (!map || !hasLeaflet) {
      return Promise.resolve();
    }

    return fetch('assets/data/district5.geojson', { cache: 'reload' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch district boundary (status ${response.status}).`);
        }

        return response.json();
      })
      .then((data) => {
        if (!data || !Array.isArray(data.features)) {
          throw new Error('Invalid GeoJSON: missing features array.');
        }

        districtData = data;

        districtLayer = L.geoJSON(data, {
          style: {
            color: '#219085',
            weight: 3,
            opacity: 0.9,
            fillOpacity: 0.12
          }
        }).addTo(map);

        const bounds = districtLayer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [24, 24] });
        }

        setStatus('neutral', 'Search for an address to begin.');
      })
      .catch((error) => {
        console.error(error);
        setStatus('error', 'Could not load District 5 boundary. Add a valid GeoJSON file at assets/data/district5.geojson.');
      });
  }

  if (resetButton && map) {
    resetButton.addEventListener('click', () => {
      hideSuggestions();

      if (addressInput) {
        addressInput.value = '';
      }

      if (districtLayer) {
        const bounds = districtLayer.getBounds();
        if (bounds.isValid()) {
          map.flyToBounds(bounds, { padding: [24, 24], duration: 0.7 });
          setStatus('neutral', 'Search for an address to begin.');
        }
      } else {
        map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
        setStatus('neutral', 'Search for an address to begin.');
      }

      if (resultMarker) {
        resultMarker.remove();
        resultMarker = null;
      }
    });
  }

  bindNavigation();
  if (addressInput && resultsList && autocompleteEngine) {
    attachSearchHandlers();
  }

  if (map) {
    loadDistrictLayer().finally(bindMapInteractions);
  }
})();
