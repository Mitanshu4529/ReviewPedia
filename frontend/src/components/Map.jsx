import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { API_BASE_URL } from '../config';
import L from 'leaflet';

import { RefreshCw, X } from 'lucide-react';
import LoadingPopup from './LoadingPopup';

const getReliableUserLocation = (onSuccess, onError) => {
  if (!navigator.geolocation) {
    if (onError) onError(new Error("Geolocation not supported"));
    return;
  }
  // Try fast IP/Wi-Fi geolocation first (instant on desktop browsers)
  navigator.geolocation.getCurrentPosition(
    (pos) => onSuccess([pos.coords.latitude, pos.coords.longitude]),
    () => {
      // Fallback try with high accuracy if standard fails (for mobile devices with GPS)
      navigator.geolocation.getCurrentPosition(
        (pos) => onSuccess([pos.coords.latitude, pos.coords.longitude]),
        (err2) => { if (onError) onError(err2); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    },
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
  );
};

// Module-level in-memory cache that persists during SPA session and resets on hard page refresh.
// It holds the map statistics (one entry per marker / hexagon) that the server
// computes over every matching review; the reviews themselves are loaded page by
// page when a marker is opened.
let memoryStatsCache = {
  data: null,
  query: null
};

const buildFilterParams = (searchQuery, categoryQuery) => {
  const params = new URLSearchParams();
  if (searchQuery && searchQuery.trim()) params.append('search', searchQuery.trim());
  if (categoryQuery && categoryQuery !== 'All') params.append('category', categoryQuery);
  return params;
};

const AppMap = forwardRef(({ onReviewSelect, searchQuery, categoryQuery, mapUpdateTrigger, viewMode, currentUser, hexResolution }, ref) => {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const hexagonsLayer = useRef(null);
  const markersLayer = useRef(null);
  const userDotLayer = useRef(null);
  
  const [userLocation, setUserLocation] = useState(null);
  const [reviews, setReviews] = useState(() => memoryStatsCache.data || []);
  const [loadingMsg, setLoadingMsg] = useState(null);
  
  const [selectedHexagon, setSelectedHexagon] = useState(null);
  const [hexSummary, setHexSummary] = useState(null);
  const [hexLoading, setHexLoading] = useState(false);

  const reviewsRef = useRef([]);
  const viewModeRef = useRef(viewMode);
  const userLocationRef = useRef(null);
  const showUserDotRef = useRef(false);
  const hexResolutionRef = useRef(hexResolution);

  // updateLayout also runs from Leaflet's zoom/move listeners, which were bound on
  // the first render. Anything it hands to a marker or hexagon is read through a
  // ref so those handlers always see the current search and callbacks.
  const onReviewSelectRef = useRef(onReviewSelect);
  const filtersRef = useRef({ searchQuery, categoryQuery });
  onReviewSelectRef.current = onReviewSelect;
  filtersRef.current = { searchQuery, categoryQuery };

  useEffect(() => { reviewsRef.current = reviews; }, [reviews]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { userLocationRef.current = userLocation; }, [userLocation]);
  useEffect(() => { hexResolutionRef.current = hexResolution; }, [hexResolution]);

  useEffect(() => {
    // 1. Initialize empty map
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, {
        zoomControl: false,
      });

      const cartoKey = import.meta.env.VITE_CARTO_API_KEY;
      const tileUrl = cartoKey
        ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${cartoKey}`
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

      L.tileLayer(tileUrl, {
        attribution: cartoKey
          ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        subdomains: cartoKey ? 'abcd' : 'abc',
        maxZoom: cartoKey ? 20 : 19
      }).addTo(mapInstance.current);

      L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current);

      // Listen to zoom to update clusters
      mapInstance.current.on('zoomend', () => {
         updateLayout();
         saveMapState();
      });
      mapInstance.current.on('moveend', () => {
         updateLayout();
         saveMapState();
      });

      const saveMapState = () => {
         if (!mapInstance.current) return;
         const center = mapInstance.current.getCenter();
         const zoom = mapInstance.current.getZoom();
         sessionStorage.setItem('mapState', JSON.stringify({ lat: center.lat, lng: center.lng, zoom }));
      };
    }

    // 2. Restore map view state or request user geolocation
    const storedStateStr = sessionStorage.getItem('mapState');
    const storedUserLocStr = sessionStorage.getItem('userLoc');

    if (storedUserLocStr) {
      try {
        const parsedLoc = JSON.parse(storedUserLocStr);
        if (parsedLoc && Array.isArray(parsedLoc) && parsedLoc.length === 2 && (parsedLoc[0] !== 28.7041 || parsedLoc[1] !== 77.1025)) {
          setUserLocation(parsedLoc);
        } else {
          sessionStorage.removeItem('userLoc');
        }
      } catch (e) {}
    }

    if (storedStateStr) {
      try {
        const state = JSON.parse(storedStateStr);
        mapInstance.current.setView([state.lat, state.lng], state.zoom);
      } catch (e) {
        mapInstance.current.setView([20, 0], 2);
      }
    } else {
      // First visit: try reliable geolocation to center map on user's real location
      getReliableUserLocation(
        (loc) => {
          setUserLocation(loc);
          sessionStorage.setItem('userLoc', JSON.stringify(loc));
          if (mapInstance.current) {
            mapInstance.current.setView(loc, 13);
          }
        },
        () => {
          if (mapInstance.current) {
            mapInstance.current.setView([20, 0], 2);
          }
        }
      );
    }

    // Destroy the map when the component goes away (e.g. on the way to /chat);
    // only removing the listeners left a whole Leaflet instance behind each time,
    // and under StrictMode the re-run then found a map without its listeners.
    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
      hexagonsLayer.current = null;
      markersLayer.current = null;
      userDotLayer.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    locateUser,
    invalidateSize: () => {
      if (mapInstance.current) {
        mapInstance.current.invalidateSize();
      }
    },
    refetchReviews: () => initData(true)
  }));

  const locateUser = () => {
    setLoadingMsg("Locating your position...");
    getReliableUserLocation(
      (loc) => {
        setUserLocation(loc);
        sessionStorage.setItem('userLoc', JSON.stringify(loc));
        sessionStorage.setItem('mapState', JSON.stringify({ lat: loc[0], lng: loc[1], zoom: 14 }));
        showUserDotRef.current = true;
        if (mapInstance.current) {
           mapInstance.current.flyTo(loc, 14);
           updateLayout();
        }
        setLoadingMsg(null);
        setTimeout(() => {
            showUserDotRef.current = false;
            updateLayout();
        }, 10000);
      },
      (error) => {
        console.warn("Geolocation error:", error);
        setLoadingMsg("Location access denied or unavailable.");
        setTimeout(() => setLoadingMsg(null), 3000);
      }
    );
  };

  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      initData(false);
    } else {
      // If mapUpdateTrigger, searchQuery, or categoryQuery changed, fetch fresh data
      initData(true);
    }
  }, [searchQuery, categoryQuery, mapUpdateTrigger, viewMode, hexResolution]);

  const latestRequest = useRef(0);

  // Loads the map statistics for the current view. The server aggregates over
  // every matching review, so marker counts and hexagon numbers are complete
  // (they used to be computed in the browser from the first 500 reviews).
  const initData = async (forced = false) => {
    const isBusiness = viewMode === 'business';
    // Only the two map views show data; the landing page and other pages do not load any.
    if (!isBusiness && viewMode !== 'consumer') return;
    // The hexagon size only matters in the business view.
    const mode = isBusiness ? `hex${hexResolution}` : 'markers';
    const currentKey = `${searchQuery || ''}__${categoryQuery || 'All'}__${mode}`;
    // If we have cached statistics for this exact query and not forced, use memory instantly
    if (!forced && memoryStatsCache.data && memoryStatsCache.query === currentKey) {
      setReviews(memoryStatsCache.data);
      setLoadingMsg(null);
      return;
    }

    const requestId = ++latestRequest.current;
    try {
      if (!memoryStatsCache.data) {
        setLoadingMsg("Fetching reviews...");
      }
      const API_URL = API_BASE_URL;
      const params = buildFilterParams(searchQuery, categoryQuery);
      if (isBusiness) params.append('resolution', String(hexResolution));
      const qStr = params.toString();
      const url = `${API_URL}/api/reviews/map-stats${qStr ? `?${qStr}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Map statistics request failed (${res.status})`);
      const data = await res.json();
      // A slower, older request must not overwrite a newer one.
      if (requestId !== latestRequest.current) return;

      const cells = (Array.isArray(data.cells) ? data.cells : []).map(c => ({ ...c, mode }));

      memoryStatsCache = {
        data: cells,
        query: currentKey
      };

      setReviews(cells);
      setLoadingMsg(null);
    } catch (error) {
      console.error("Fetch error:", error);
      if (requestId !== latestRequest.current) return;
      setLoadingMsg("Error loading reviews.");
      setTimeout(() => setLoadingMsg(prev => (prev === "Error loading reviews." ? null : prev)), 4000);
    }
  };

  // Only the summary for the most recently clicked hexagon may be shown.
  const latestSummaryRequest = useRef(0);
  const fetchHexagonSummary = async (cellId) => {
      const requestId = ++latestSummaryRequest.current;
      const isCurrent = () => requestId === latestSummaryRequest.current;
      setHexLoading(true);
      setHexSummary(null);
      try {
          const API_URL = API_BASE_URL;
          // A sample of the reviews inside the hexagon (the summary endpoint reads at most 50).
          const params = buildFilterParams(filtersRef.current.searchQuery, filtersRef.current.categoryQuery);
          params.append('cell', cellId);
          params.append('limit', '50');
          const listRes = await fetch(`${API_URL}/api/reviews?${params.toString()}`);
          if (!listRes.ok) throw new Error(`Review request failed (${listRes.status})`);
          const hexReviews = (await listRes.json()).reviews || [];
          const res = await fetch(`${API_URL}/api/agents/hexagon-summary`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reviews: hexReviews.map(r => ({ rating: r.review?.rating, text: r.review?.text || r.review?.title })) })
          });
          const data = await res.json().catch(() => ({}));
          if (!isCurrent()) return;
          if (data.success) setHexSummary(data.result);
          else setHexSummary("Failed to generate AI summary.");
      } catch (err) {
          if (isCurrent()) setHexSummary("Network error generating summary.");
      } finally {
          if (isCurrent()) setHexLoading(false);
      }
  };

  useEffect(() => {
    if (reviews.length >= 0 && mapInstance.current) {
      updateLayout();
    }
  }, [reviews, viewMode]);

  const updateLayout = () => {
    if (!mapInstance.current) return;

    if (hexagonsLayer.current) {
      mapInstance.current.removeLayer(hexagonsLayer.current);
    }
    if (markersLayer.current) {
      mapInstance.current.removeLayer(markersLayer.current);
    }
    if (userDotLayer.current) {
      mapInstance.current.removeLayer(userDotLayer.current);
    }

    hexagonsLayer.current = L.featureGroup().addTo(mapInstance.current);
    markersLayer.current = L.featureGroup().addTo(mapInstance.current);
    userDotLayer.current = L.featureGroup().addTo(mapInstance.current);

    // Plot User Location Dot
    if (showUserDotRef.current && userLocationRef.current) {
        const userIcon = L.divIcon({
            className: 'user-dot-marker',
            html: `<div style="background-color: var(--primary-strong); width: 16px; height: 16px; border-radius: 50%; border: 1px solid white; box-shadow: 0 0 10px rgba(81, 56, 214, 0.5);"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });
        const userMarker = L.marker(userLocationRef.current, { icon: userIcon, zIndexOffset: 1000 }).bindTooltip("You are here");
        userDotLayer.current.addLayer(userMarker);
    }

    const zoom = mapInstance.current.getZoom();
    const currentViewMode = viewModeRef.current;

    // Statistics that belong to the view being shown (after a switch the previous
    // view's entries stay in state until the new ones arrive).
    const expectedMode = currentViewMode === 'business' ? `hex${hexResolutionRef.current}` : 'markers';
    const currentCells = reviewsRef.current.filter(c => c.mode === expectedMode);
    if (currentCells.length === 0) return;

    // Consumer Mode: one marker per location, labelled with its review count
    if (currentViewMode === 'consumer') {
       currentCells.forEach(cell => {
           const centerLat = cell.lat;
           const centerLng = cell.lng;
           if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) return;

           const bgColor = 'var(--primary-strong)'; // dark enough for the white count
           const size = cell.count > 9 ? 26 : 22;
           const label = `${cell.count} review${cell.count === 1 ? '' : 's'} here`;
           const icon = L.divIcon({
              className: 'custom-marker',
              html: `<div style="background-color: ${bgColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: 1px solid white; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: ${cell.count > 9 ? 10 : 11}px">${cell.count > 999 ? '999+' : cell.count}</div>`,
              iconSize: [size, size],
              iconAnchor: [size/2, size/2]
           });
           // title/alt give the marker an accessible name; Leaflet markers are keyboard focusable.
           const marker = L.marker([centerLat, centerLng], { icon, title: label, alt: label });
           const open = () => onReviewSelectRef.current({ h3Index: cell.h3Index, count: cell.count }); // App loads the reviews page by page
           marker.on('click', open);
           // Leaflet makes markers focusable but does not activate them from the keyboard.
           marker.on('keypress', (e) => { if (e.originalEvent?.key === 'Enter') open(); });
           markersLayer.current.addLayer(marker);
       });
       return; // Skip H3 logic entirely
    }

    // Business Mode: H3 Hexagonal Density
    if (currentViewMode === 'business') {
        const maxCount = Math.max(...currentCells.map(c => c.count), 1);

        // We removed the marker fallback so the resolution slider is strictly honored at all zoom levels.

        currentCells.forEach(cell => {
            const h3Index = cell.h3Index;
            const count = cell.count;
            const intensity = count / maxCount;

            const boundary = cell.boundary;
            if (!Array.isArray(boundary)) return;

            const polygon = L.polygon(boundary, {
                color: '#5138d6', // distinction color for business mode
                weight: 1,
                fillColor: `rgba(81, 56, 214, ${0.2 + (0.6 * intensity)})`,
                fillOpacity: 0.6 + (0.3 * intensity)
            });

            polygon.bindTooltip(`Density: ${count} Reviews`);
            polygon.on('click', () => {
                // Computed by the server over every review in the hexagon.
                const avgRating = typeof cell.avgRating === 'number' ? cell.avgRating.toFixed(1) : 'N/A';
                const maxRating = cell.maxRating ?? 'N/A';
                const minRating = cell.minRating ?? 'N/A';

                setSelectedHexagon({
                    id: h3Index,
                    count,
                    avgRating,
                    maxRating,
                    minRating
                });
                
                mapInstance.current.flyTo(polygon.getBounds().getCenter(), zoom + 1);
                fetchHexagonSummary(h3Index);
            });

            hexagonsLayer.current.addLayer(polygon);
        });
    }
  };

  // The map stays mounted behind the landing, profile and review pages. There it
  // is taken out of the tab order and the accessibility tree, so keyboard users
  // do not land on zoom buttons they cannot see.
  const isMapView = viewMode === 'consumer' || viewMode === 'business';

  return (
    <div {...(isMapView ? {} : { inert: '', 'aria-hidden': true })} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <LoadingPopup message={loadingMsg} />
      


      {/* Hexagon Side Panel */}
      {viewMode === 'business' && selectedHexagon && (
        <div className="glass-panel" style={{
            position: 'absolute', top: 100, right: 30, width: '380px', zIndex: 1000, 
            background: 'var(--surface-lowest)', borderRadius: '16px', border: '1px solid var(--outline-variant)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px',
            maxHeight: '80vh', overflowY: 'auto'
        }}>
            <button onClick={() => setSelectedHexagon(null)} aria-label="Close hexagon details" style={{ position: 'absolute', top: 15, right: 15,background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)' }}>
                <X size={20} />
            </button>
            <h3 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--on-surface)' }}>Hexagon Cluster</h3>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>Region ID: {selectedHexagon.id}</p>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="tonal-panel" style={{ padding: '12px', background: 'var(--surface-highest)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reviews</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--primary-strong)' }}>{selectedHexagon.count}</div>
                </div>
                <div className="tonal-panel" style={{ padding: '12px', background: 'var(--surface-highest)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg Rating</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--golden-star)' }}>{selectedHexagon.avgRating} <span style={{fontSize:'1rem'}}>★</span></div>
                </div>
                <div className="tonal-panel" style={{ padding: '12px', background: 'var(--surface-highest)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Worst Rating</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#ef4444' }}>{selectedHexagon.minRating} <span style={{fontSize:'0.8rem'}}>★</span></div>
                </div>
                <div className="tonal-panel" style={{ padding: '12px', background: 'var(--surface-highest)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Best Rating</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#22c55e' }}>{selectedHexagon.maxRating} <span style={{fontSize:'0.8rem'}}>★</span></div>
                </div>
            </div>

            <div style={{ marginTop: '10px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9rem', color: 'var(--on-surface)' }}>AI Sentimental Summary</h4>
                <div className="tonal-panel" style={{ padding: '16px', background: 'var(--surface-highest)', minHeight: '100px', fontSize: '0.9rem', lineHeight: '1.5', color: 'var(--on-surface)' }}>
                    {hexLoading ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary-strong)' }}>
                            <RefreshCw className="animate-spin" size={16} /> Analyzing local sentiment...
                        </div>
                    ) : (
                        hexSummary || "No summary available."
                    )}
                </div>
            </div>
        </div>
      )}
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
});

AppMap.displayName = 'AppMap';

export default AppMap;
