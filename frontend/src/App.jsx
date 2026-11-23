import React, { useState, useRef, useEffect } from 'react';
import { API_BASE_URL } from './config';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Plus, MapPin, ArrowRight, ArrowUpRight, ArrowLeft, Mail, Crosshair, Hexagon, Youtube, Linkedin, Instagram, Facebook, CheckCircle2, Calendar, Heart, ChevronDown } from 'lucide-react';
import AppMap from './components/Map';
import MultiReviewCard from './components/MultiReviewCard';
import AgentBox from './components/AgentBox';
import CreateReview from './components/CreateReview';
import UserProfile from './components/UserProfile';
import MyProfilePage from './components/MyProfilePage';
import AuthModal from './components/AuthModal';
import ChatApp from './components/ChatApp';
import ReviewDetailPage from './components/ReviewDetailPage';
import StarRating from './components/StarRating';
import NotificationIcon from './components/NotificationIcon';
import ChatIcon from './components/ChatIcon';
import CategorySelectModal from './components/CategorySelectModal';
import { useAuth } from './context/AuthContext';
import { useChat } from './context/ChatContext';
import { formatDate } from './utils/dateUtils';
import { pressable, useModalA11y } from './utils/a11y';
import './index.css';
import { notify } from './utils/notify';

function App() {
  const mapComponentRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();

  let appMode = 'landing';
  if (location.pathname.startsWith('/browse')) appMode = 'consumer';
  else if (location.pathname.startsWith('/research')) appMode = 'business';
  else if (location.pathname.startsWith('/profile')) appMode = 'myProfileSettings';
  else if (location.pathname.startsWith('/chat')) appMode = 'chat';
  else if (location.pathname.startsWith('/reviews/') || location.pathname.startsWith('/review/')) appMode = 'reviewDetail';
  const [selectedLocationReviews, setSelectedLocationReviews] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [initialChatUser, setInitialChatUser] = useState(null);
  const [isCreatingReview, setIsCreatingReview] = useState(false);
  const [editingReviewData, setEditingReviewData] = useState(null);
  const [isMyReviewsOpen, setIsMyReviewsOpen] = useState(false);
  const [myReviewsList, setMyReviewsList] = useState([]);
  const [isHexagonSettingsOpen, setIsHexagonSettingsOpen] = useState(false);
  const [hexResolution, setHexResolution] = useState(5);
  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [categoryQuery, setCategoryQuery] = useState('All');
  const [isCategoryDropdownOpen, setIsCategoryDropdownOpen] = useState(false);
  const categoryDropdownRef = useRef(null);
  const categoryBoxRef = useRef(null);
  const [mapUpdateTrigger, setMapUpdateTrigger] = useState(0);
  const [isBrowseBackHovered, setIsBrowseBackHovered] = useState(false);

  const [showEmailPrompt, setShowEmailPrompt] = useState(false);
  const [marketResearchEmail, setMarketResearchEmail] = useState('');
  const emailPromptRef = useModalA11y(() => setShowEmailPrompt(false), showEmailPrompt);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const { user, logout, setUser, loading: authLoading } = useAuth();
  const { unreadChatCount } = useChat();

  const homepageProfileRef = useRef(null);
  const [isHomepageProfileOpen, setIsHomepageProfileOpen] = useState(false);

  React.useEffect(() => {
    const handleClickOutside = (e) => {
      if (homepageProfileRef.current && !homepageProfileRef.current.contains(e.target)) {
        setIsHomepageProfileOpen(false);
      }
    };
    // Escape closes the account menu too (keyboard users had no way out).
    const handleKeyDown = (e) => { if (e.key === 'Escape') setIsHomepageProfileOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  React.useEffect(() => {
    // Reset all review windows on route change
    setIsCreatingReview(false);
    setEditingReviewData(null);
    setSelectedLocationReviews(null);
    setIsMyReviewsOpen(false);

    if (location.pathname.startsWith('/browse') || location.pathname.startsWith('/research')) {
      setTimeout(() => {
        mapComponentRef.current?.invalidateSize?.();
      }, 50);
    }
  }, [location.pathname]);

  // Review lists (one map marker, or "My Reviews") are loaded from the server a
  // page at a time. `reviewPaging` describes the list that is currently open.
  const REVIEW_PAGE_SIZE = 20;
  const [reviewPaging, setReviewPaging] = useState(null); // { kind, params, total, nextCursor, loading }
  const reviewListRequest = useRef(0);

  const fetchReviewPage = async (params, cursor) => {
    const qs = new URLSearchParams({ ...params, limit: String(REVIEW_PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${API_BASE_URL}/api/reviews?${qs.toString()}`);
    if (!res.ok) throw new Error(`Could not load reviews (${res.status})`);
    return res.json();
  };

  const openReviewList = async (kind, params) => {
    const requestId = ++reviewListRequest.current;
    try {
      const page = await fetchReviewPage(params);
      if (requestId !== reviewListRequest.current) return; // a newer list was opened meanwhile
      setReviewPaging({ kind, params, total: page.total, nextCursor: page.nextCursor, loading: false });
      if (kind === 'mine') {
        setMyReviewsList(page.reviews);
        setIsMyReviewsOpen(true);
        setSelectedLocationReviews(null);
      } else {
        setSelectedLocationReviews(page.reviews);
        setIsMyReviewsOpen(false);
      }
    } catch (err) {
      console.error('Failed to fetch reviews', err);
      if (requestId === reviewListRequest.current) notify('Could not load reviews. Please try again.');
    }
  };

  const handleLoadMoreReviews = async () => {
    if (!reviewPaging || !reviewPaging.nextCursor || reviewPaging.loading) return;
    const requestId = reviewListRequest.current;
    const { kind, params, nextCursor } = reviewPaging;
    setReviewPaging(prev => (prev ? { ...prev, loading: true } : prev));
    try {
      const page = await fetchReviewPage(params, nextCursor);
      if (requestId !== reviewListRequest.current) return;
      const append = (prevList) => {
        const known = new Set((prevList || []).map(r => r.id || r._id));
        return [...(prevList || []), ...page.reviews.filter(r => !known.has(r.id || r._id))];
      };
      if (kind === 'mine') setMyReviewsList(append);
      else setSelectedLocationReviews(append);
      setReviewPaging(prev => (prev ? { ...prev, total: page.total, nextCursor: page.nextCursor, loading: false } : prev));
    } catch (err) {
      console.error('Failed to fetch more reviews', err);
      if (requestId !== reviewListRequest.current) return;
      setReviewPaging(prev => (prev ? { ...prev, loading: false } : prev));
      notify('Could not load more reviews. Please try again.');
    }
  };

  // A map marker was opened: `selection` is { h3Index, count } for that location.
  const handleReviewSelect = (selection) => {
    if (!selection?.h3Index) return;
    setIsMyReviewsOpen(false);
    const params = { h3Index: selection.h3Index };
    if (query && query.trim()) params.search = query.trim();
    if (categoryQuery && categoryQuery !== 'All') params.category = categoryQuery;
    openReviewList('location', params);
  };

  const handleLikeToggle = (reviewId, newLikes) => {
    setSelectedLocationReviews(prevList => {
      if (!Array.isArray(prevList)) return prevList;
      return prevList.map(r => {
        const id = r.id || r._id;
        if (id === reviewId || id?.toString() === reviewId?.toString()) {
          return { ...r, likes: newLikes };
        }
        return r;
      });
    });

    setMyReviewsList(prevList => {
      if (!Array.isArray(prevList)) return prevList;
      return prevList.map(r => {
        const id = r.id || r._id;
        if (id === reviewId || id?.toString() === reviewId?.toString()) {
          return { ...r, likes: newLikes };
        }
        return r;
      });
    });
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      const isOutsideTrigger = categoryDropdownRef.current && !categoryDropdownRef.current.contains(e.target);
      const isOutsideBox = categoryBoxRef.current && !categoryBoxRef.current.contains(e.target);
      if (isOutsideTrigger && (!categoryBoxRef.current || isOutsideBox)) {
        setIsCategoryDropdownOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsCategoryDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSearch = () => {
    setQuery(searchInput);
    setCategoryQuery(selectedCategory);
  };

  const handleCategorySelect = (cat) => {
    setSelectedCategory(cat);
    setCategoryQuery(cat);
    setIsCategoryDropdownOpen(false);
  };

  const handleOpenMyReviews = async () => {
      if (!user) return;
      const userId = user.id || user._id;
      if (!userId) return;
      // The list is only shown on the consumer map; from Research it switches there first.
      if (appMode !== 'consumer') navigate('/browse');
      // Asked for by account id on the server. (This used to download the first
      // 500 reviews of everyone and pick out the ones with a matching name.)
      await openReviewList('mine', { userId: String(userId) });
  };

  // Keeps the open list's total in step after one of its reviews is deleted.
  const noteReviewDeleted = () => {
      setReviewPaging(prev => (prev ? { ...prev, total: Math.max(0, (prev.total || 0) - 1) } : prev));
  };

  // Agent emails may only go to the account's own address (or the configured
  // demo inbox), so a signed-in user starts with their own address filled in.
  useEffect(() => {
      if (user?.email) setMarketResearchEmail(prev => prev || user.email);
  }, [user?.email]);

  const startBusinessMode = () => {
     if (!marketResearchEmail || !marketResearchEmail.includes('@')) {
         notify("Please enter a valid email address to receive Agent emails.");
         return;
     }
     setShowEmailPrompt(false);
     navigate('/research');
  };

  return (
    <div className="app-container">
      {/* Mounted map instance when in map-active views */}
      {appMode !== 'chat' && (
        <AppMap
          ref={mapComponentRef}
          onReviewSelect={handleReviewSelect}
          searchQuery={query}
          categoryQuery={categoryQuery}
          mapUpdateTrigger={mapUpdateTrigger}
          viewMode={appMode}
          currentUser={user}
          hexResolution={hexResolution}
        />
      )}

      {/* Landing Page Full-Screen Overlay */}
      {appMode === 'landing' && (
        <div
          className="landing-dark"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 8000,
            overflowY: 'auto'
          }}
        >
          {/* Header */}
          <header className="landing-dark-header">
          {/* Left: Logo */}
          <div
              className="landing-dark-logo"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              style={{
                  cursor: 'pointer',
                  fontFamily: "'Rochester', cursive",
                  fontWeight: 650,
                  fontSize: '2.2rem',
                  color: '#0f172a'
              }}
          >
             Reviewpedia
          </div>

          {/* Center: Navigation Links */}
          <nav className="landing-dark-nav" aria-label="Main" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '3rem', alignItems: 'center' }}>
             <a href="#problem" style={{ fontSize: '0.88rem' }}>About</a>
             <a href="/browse" onClick={(e) => { e.preventDefault(); navigate('/browse'); }} style={{ fontSize: '0.88rem' }}>Browse Reviews</a>
             <a href="/research" onClick={(e) => { e.preventDefault(); setShowEmailPrompt(true); }} style={{ fontSize: '0.88rem' }}>Research</a>
             <a href="#contact" style={{ fontSize: '0.88rem' }}>Contact Us</a>
          </nav>

          {/* Right: User / Auth Controls */}
          <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
             {user ? (
                 <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <ChatIcon unreadCount={unreadChatCount} color="#000000" fillColor="#F8F4F0" hoverColor="#0369a1" size={22} onClick={() => navigate('/chat')} />
                     <NotificationIcon unreadCount={0} color="#000000" fillColor="#F8F4F0" hoverColor="#0369a1" size={22} />
                     <div ref={homepageProfileRef} style={{ position: 'relative' }}>
                        <div
                            {...pressable(() => setIsHomepageProfileOpen(prev => !prev))}
                            aria-haspopup="menu"
                            aria-expanded={isHomepageProfileOpen}
                            aria-label="Account menu"
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', borderRadius: '50%' }}
                        >
                            {user.profilePic ? (
                                <img
                                    src={user.profilePic}
                                    alt="Profile"
                                    style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', display: 'block', cursor: 'pointer', border: '3px solid #0ea5e9', boxSizing: 'border-box', boxShadow: 'none' }}
                                />
                            ) : (
                                <div style={{
                                    width: '40px', height: '40px', borderRadius: '50%',
                                    backgroundColor: '#0369a1', color: 'white',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                                    border: '3px solid #0ea5e9', boxSizing: 'border-box',
                                    boxShadow: 'none'
                                }}>
                                    {user.username[0].toUpperCase()}
                                </div>
                            )}
                        </div>

                        {isHomepageProfileOpen && (
                            <div style={{
                                position: 'absolute',
                                top: '48px',
                                right: '-12px',
                                left: 'auto',
                                minWidth: '180px',
                                background: 'rgba(3, 3, 3, 0.6)',
                                border: 'none',
                                borderRadius: '16px',
                                padding: '12px',
                                backdropFilter: 'blur(12px)',
                                WebkitBackdropFilter: 'blur(12px)',
                                boxShadow: 'none',
                                zIndex: 1000,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.25rem',
                                color: '#ffffff'
                            }}>
                                {/* Top Segment: Username and Email (Always White) */}
                                <div style={{ padding: '2px 12px 6px 12px', cursor: 'default' }}>
                                    <div style={{ color: '#ffffff', fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {user.username}
                                    </div>
                                    <div style={{ color: '#ffffff', fontSize: '0.78rem', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                                        {user.email}
                                    </div>
                                </div>

                                <hr style={{ border: 'none', borderTop: '1px solid rgba(255, 255, 255, 0.08)', margin: '4px 0', padding: 0 }} />

                                <div
                                    {...pressable(() => { setIsHomepageProfileOpen(false); navigate('/profile'); })}
                                    style={{ padding: '0 12px', cursor: 'pointer', height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box', color: '#ffffff', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', borderRadius: '8px', transition: 'color 0.2s ease' }}
                                    onMouseOver={(e) => e.currentTarget.style.color = '#0ea5e9'}
                                    onMouseOut={(e) => e.currentTarget.style.color = '#ffffff'}
                                >
                                    <span>My Profile</span>
                                </div>

                                <div
                                    {...pressable(() => { setIsHomepageProfileOpen(false); navigate('/chat'); })}
                                    style={{ padding: '0 12px', cursor: 'pointer', height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box', color: '#ffffff', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', borderRadius: '8px', transition: 'color 0.2s ease' }}
                                    onMouseOver={(e) => e.currentTarget.style.color = '#0ea5e9'}
                                    onMouseOut={(e) => e.currentTarget.style.color = '#ffffff'}
                                >
                                    <span>Chats</span>
                                </div>

                                <hr style={{ border: 'none', borderTop: '1px solid rgba(255, 255, 255, 0.08)', margin: '4px 0', padding: 0 }} />

                                <div
                                    {...pressable(() => { setIsHomepageProfileOpen(false); logout(); navigate('/'); })}
                                    style={{ padding: '0 12px', cursor: 'pointer', height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box', color: '#ef4444', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', borderRadius: '8px' }}
                                >
                                    <span>Sign Out</span>
                                </div>
                            </div>
                        )}
                    </div>
                 </div>
             ) : (
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <button
                        style={{ background: 'none', border: 'none', color: '#475569', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', transition: 'color 0.2s', padding: '6px 12px' }}
                        onMouseOver={(e) => e.currentTarget.style.color = '#0369a1'}
                        onMouseOut={(e) => e.currentTarget.style.color = '#475569'}
                        onClick={() => setShowAuthModal('login')}
                    >
                        Sign In
                    </button>
                    <button
                        style={{ background: '#0369a1', border: 'none', color: '#ffffff', fontSize: '0.88rem', fontWeight: 600, padding: '8px 20px', borderRadius: '9999px', cursor: 'pointer', transition: 'background-color 0.2s' }}
                        onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#075985'}
                        onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#0369a1'}
                        onClick={() => setShowAuthModal('signup')}
                    >
                        Sign Up
                    </button>
                </div>
             )}
          </div>
        </header>

        {/* Hero Content */}
        <div className="landing-dark-content">
          <h1 className="landing-title">
             The <span style={{ color: '#0369a1', fontStyle: 'italic' }}>social media</span> for people who buy stuff <span style={{ color: '#0369a1', fontStyle: 'italic' }}>online</span>
          </h1>
          <p style={{ color: '#475569', fontSize: '1.2rem', maxWidth: '680px', textAlign: 'center', marginBottom: '2.5rem', lineHeight: 1.65 }}>
             Reviewpedia helps you find real reviews of everyday items from people around you. Make friends , chat, discuss
          </p>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '7rem' }}>
              <button className="landing-btn-primary" onClick={() => navigate('/browse')}>
                  Get Started <ArrowRight size={18} />
              </button>
              <button className="landing-btn-outline" onClick={() => setShowEmailPrompt(true)}>
                  Market Research
              </button>
          </div>
        </div>

        {/* Section 1: The Online Shopping Dilemma */}
        <section id="problem" style={{ position: 'relative', zIndex: 2, padding: '180px 2rem 150px 2rem', maxWidth: 1380, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontSize: '3.2rem', fontWeight: 800, letterSpacing: '-0.04em', color: '#161E2E', marginBottom: '4rem', fontFamily: 'var(--font-display)' }}>
            Why Traditional Reviews Fail You
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2rem', textAlign: 'left' }}>
            <div className="landing-card" style={{ padding: '2.2rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#161E2E', margin: '0 0 0.6rem 0' }}>Fake & Paid Reviews</h3>
              <p style={{ color: '#64748b', fontSize: '1.02rem', lineHeight: 1.65, margin: 0 }}>
                Shopping platforms like Amazon and Flipkart contain incentivized 5-star ratings that distort real product ratings.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.2rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#161E2E', margin: '0 0 0.6rem 0' }}>Silent Influencers</h3>
              <p style={{ color: '#64748b', fontSize: '1.02rem', lineHeight: 1.65, margin: 0 }}>
                YouTube & Insta reviewers get paid to promote items and rarely reply to DMs or comments when you need real answers.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.2rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#161E2E', margin: '0 0 0.6rem 0' }}>Regional Quality Traps</h3>
              <p style={{ color: '#64748b', fontSize: '1.02rem', lineHeight: 1.65, margin: 0 }}>
                A positive review in Delhi won't guarantee quality in Bengaluru due to local suppliers and distributor variances.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.2rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#161E2E', margin: '0 0 0.6rem 0' }}>Anonymous Chaos</h3>
              <p style={{ color: '#64748b', fontSize: '1.02rem', lineHeight: 1.65, margin: 0 }}>
                Quora and Reddit threads lack verified ownership and location checks, leading to unverified, chaotic opinions.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2: Core Pillars */}
        <section id="features" style={{ position: 'relative', zIndex: 2, padding: '150px 2rem', maxWidth: 1380, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontSize: '3.2rem', fontWeight: 800, letterSpacing: '-0.04em', color: '#161E2E', marginBottom: '4rem', fontFamily: 'var(--font-display)' }}>
            How Reviewpedia Empowers You
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2rem', textAlign: 'left' }}>
            <div className="landing-card" style={{ padding: '2.5rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.45rem', fontWeight: 700, color: '#161E2E', marginBottom: '0.75rem' }}>Hyper-Local Map Pins</h3>
              <p style={{ color: '#475569', lineHeight: 1.7, fontSize: '1.05rem', margin: 0 }}>
                Discover what people in your city or neighborhood are buying. See real-world feedback tied to your location.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.5rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.45rem', fontWeight: 700, color: '#161E2E', marginBottom: '0.75rem' }}>Direct 1-on-1 Chat</h3>
              <p style={{ color: '#475569', lineHeight: 1.7, fontSize: '1.05rem', margin: 0 }}>
                Have questions about a product? Click to DM real buyers directly, ask for photos, discuss, or even meet up.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.5rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.45rem', fontWeight: 700, color: '#161E2E', marginBottom: '0.75rem' }}>Centralized Cross-Site Ratings</h3>
              <p style={{ color: '#475569', lineHeight: 1.7, fontSize: '1.05rem', margin: 0 }}>
                No more tab switching. Compare ratings from Amazon (3.2★), Flipkart (3.4★), and official stores (4.8★) in one place.
              </p>
            </div>

            <div className="landing-card" style={{ padding: '2.5rem', alignItems: 'flex-start', textAlign: 'left' }}>
              <h3 style={{ fontSize: '1.45rem', fontWeight: 700, color: '#161E2E', marginBottom: '0.75rem' }}>Location-Isolated Feedback</h3>
              <p style={{ color: '#475569', lineHeight: 1.7, fontSize: '1.05rem', margin: 0 }}>
                Fake or paid reviews in one location don't affect your experience in other locations. Feedback is anchored locally to your area.
              </p>
            </div>
          </div>
        </section>

        {/* Section 3: Comparison Table */}
        <section id="comparison" style={{ position: 'relative', zIndex: 2, padding: '150px 2rem', maxWidth: 1380, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontSize: '3.2rem', fontWeight: 800, letterSpacing: '-0.04em', color: '#161E2E', marginBottom: '1.25rem', fontFamily: 'var(--font-display)' }}>
            The Clear Difference
          </h2>
          <p style={{ color: '#475569', fontSize: '1.25rem', marginBottom: '4rem' }}>See how Reviewpedia compares to traditional review channels.</p>

          <div style={{ background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', borderRadius: '28px', border: '1px solid rgba(2, 132, 199, 0.15)', overflow: 'hidden', boxShadow: '0 20px 40px rgba(15, 23, 42, 0.05)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontFamily: 'var(--font-body)' }}>
              <thead>
                <tr style={{ background: '#161E2E', color: '#ffffff' }}>
                  <th style={{ padding: '22px 28px', fontSize: '1.1rem', fontWeight: 600 }}>Feature</th>
                  <th style={{ padding: '22px 20px', fontSize: '1.05rem', fontWeight: 500, textAlign: 'center' }}>Amazon / Flipkart</th>
                  <th style={{ padding: '22px 20px', fontSize: '1.05rem', fontWeight: 500, textAlign: 'center' }}>Insta / YouTube</th>
                  <th style={{ padding: '22px 20px', fontSize: '1.05rem', fontWeight: 500, textAlign: 'center' }}>Reddit / Quora</th>
                  <th style={{ padding: '22px 20px', fontSize: '1.05rem', fontWeight: 600, textAlign: 'center', background: '#0369a1', color: '#ffffff' }}>Reviewpedia</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid rgba(2, 132, 199, 0.08)' }}>
                  <td style={{ padding: '20px 28px', fontWeight: 600, color: '#161E2E', fontSize: '1.05rem' }}>Location-Based Reviews</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#161E2E', fontWeight: 600, fontSize: '1.05rem' }}>City Name Only</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#0369a1', fontWeight: 700, fontSize: '1.05rem', background: 'rgba(14, 165, 233, 0.05)' }}>Hyper-Local Pins</td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(2, 132, 199, 0.08)' }}>
                  <td style={{ padding: '20px 28px', fontWeight: 600, color: '#161E2E', fontSize: '1.05rem' }}>1-on-1 Chat with Reviewer</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>Unresponsive DMs</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#161E2E', fontWeight: 600, fontSize: '1.05rem' }}>Public Threads</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#0369a1', fontWeight: 700, fontSize: '1.05rem', background: 'rgba(14, 165, 233, 0.05)' }}>Direct 1-on-1 DM</td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(2, 132, 199, 0.08)' }}>
                  <td style={{ padding: '20px 28px', fontWeight: 600, color: '#161E2E', fontSize: '1.05rem' }}>Make Friends</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#161E2E', fontWeight: 600, fontSize: '1.05rem' }}>Yes</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#0369a1', fontWeight: 700, fontSize: '1.05rem', background: 'rgba(14, 165, 233, 0.05)' }}>Yes</td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(2, 132, 199, 0.08)' }}>
                  <td style={{ padding: '20px 28px', fontWeight: 600, color: '#161E2E', fontSize: '1.05rem' }}>Centralized Cross-Site Ratings</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>Platform Only</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No Ratings</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>No Ratings</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#0369a1', fontWeight: 700, fontSize: '1.05rem', background: 'rgba(14, 165, 233, 0.05)' }}>Multi-Platform Aggregated</td>
                </tr>
                <tr>
                  <td style={{ padding: '20px 28px', fontWeight: 600, color: '#161E2E', fontSize: '1.05rem' }}>Protection from Paid/Bot Reviews</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>High Fake Rate</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>Paid Sponsorships</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#ef4444', fontSize: '1.05rem' }}>Anonymous Noise</td>
                  <td style={{ padding: '20px 20px', textAlign: 'center', color: '#0369a1', fontWeight: 700, fontSize: '1.05rem', background: 'rgba(14, 165, 233, 0.05)' }}>Literally Your Neighbours</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 4: Community Spotlight */}
        <section id="community" style={{ position: 'relative', zIndex: 2, padding: '150px 2rem', maxWidth: 1380, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontSize: '3.2rem', fontWeight: 800, letterSpacing: '-0.04em', color: '#161E2E', marginBottom: '1.25rem', fontFamily: 'var(--font-display)' }}>
            Connect With Real Shoppers
          </h2>
          <p style={{ color: '#475569', fontSize: '1.25rem', marginBottom: '4rem' }}>
            See what people around you are reviewing and chat with them in real-time.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '2rem', textAlign: 'left' }}>
            {/* Review Card 1 */}
            <div style={{ background: '#F8F4F0', borderRadius: '24px', border: '1px solid #e4e4e7', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)', textAlign: 'left' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ width: 76, height: 76, backgroundColor: '#e4e4e7', border: '1px solid #cbd5e1', borderRadius: 12, overflow: 'hidden', flexShrink: 0 }}>
                  <img src="/sony-wh1000xm5.jpg" alt="Sony WH-1000XM5" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#161E2E', margin: '0 0 6px 0', wordBreak: 'break-word' }}>
                    Sony WH-1000XM5
                  </h3>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '9999px', padding: '2px 10px', color: '#0369a1', fontSize: '0.75rem', fontWeight: 600 }}>Sony</span>
                    <span style={{ backgroundColor: 'rgba(100, 116, 139, 0.1)', borderRadius: '9999px', padding: '2px 10px', color: '#475569', fontSize: '0.75rem', fontWeight: 500 }}>Electronics</span>
                  </div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    <StarRating rating={5} size={15} gap={3} />
                  </div>
                </div>
              </div>

              <p style={{ margin: 0, padding: '4px 0', lineHeight: 1.6, fontSize: '0.98rem', fontFamily: 'var(--font-body)', color: '#27272a' }}>
                "Noise cancellation is incredible for commuting in Delhi Metro. Battery easily lasts 30+ hours."
              </p>

              {/* Heart button right above horizontal rule */}
              <div style={{ display: 'flex', alignItems: 'center', margin: '0 0 2px 0' }}>
                <span
                  aria-label="12 likes"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                    padding: '3px 8px', color: '#52525b', fontSize: '0.75rem', fontWeight: 600
                  }}
                >
                  <Heart size={14} fill="none" color="#52525b" aria-hidden="true" />
                  <span aria-hidden="true">12</span>
                </span>
              </div>

              <div style={{ paddingTop: '16px', marginTop: '4px', borderTop: '1px solid #e4e4e7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#0369a1', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1rem', flexShrink: 0 }}>
                    R
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 5, margin: 0, color: '#161E2E' }}>
                      Rahul Sharma <CheckCircle2 size={14} color="#0369a1" />
                    </p>
                    <p style={{ fontSize: '0.78rem', color: '#64748b', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MapPin size={12} color="#0369a1" /> New Delhi
                    </p>
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#71717a', display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-body)', flexShrink: 0 }}>
                  <Calendar size={13} /> {formatDate('2026-08-05')}
                </div>
              </div>
            </div>

            {/* Review Card 2 */}
            <div style={{ background: '#F8F4F0', borderRadius: '24px', border: '1px solid #e4e4e7', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)', textAlign: 'left' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ width: 76, height: 76, backgroundColor: '#e4e4e7', border: '1px solid #cbd5e1', borderRadius: 12, overflow: 'hidden', flexShrink: 0 }}>
                  <img src="/macbook m2.jpg" alt="MacBook Air M2" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#161E2E', margin: '0 0 6px 0', wordBreak: 'break-word' }}>
                    MacBook Air M2
                  </h3>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '9999px', padding: '2px 10px', color: '#0369a1', fontSize: '0.75rem', fontWeight: 600 }}>Apple</span>
                    <span style={{ backgroundColor: 'rgba(100, 116, 139, 0.1)', borderRadius: '9999px', padding: '2px 10px', color: '#475569', fontSize: '0.75rem', fontWeight: 500 }}>Laptops</span>
                  </div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    <StarRating rating={5} size={15} gap={3} />
                  </div>
                </div>
              </div>

              <p style={{ margin: 0, padding: '4px 0', lineHeight: 1.6, fontSize: '0.98rem', fontFamily: 'var(--font-body)', color: '#27272a' }}>
                "Super lightweight for work. Keyboard feels solid and display is super bright."
              </p>

              {/* Heart button right above horizontal rule */}
              <div style={{ display: 'flex', alignItems: 'center', margin: '0 0 2px 0' }}>
                <span
                  aria-label="19 likes"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                    padding: '3px 8px', color: '#52525b', fontSize: '0.75rem', fontWeight: 600
                  }}
                >
                  <Heart size={14} fill="none" color="#52525b" aria-hidden="true" />
                  <span aria-hidden="true">19</span>
                </span>
              </div>

              <div style={{ paddingTop: '16px', marginTop: '4px', borderTop: '1px solid #e4e4e7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#0369a1', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1rem', flexShrink: 0 }}>
                    P
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 5, margin: 0, color: '#161E2E' }}>
                      Priya Patel <CheckCircle2 size={14} color="#0369a1" />
                    </p>
                    <p style={{ fontSize: '0.78rem', color: '#64748b', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MapPin size={12} color="#0369a1" /> Bengaluru
                    </p>
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#71717a', display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-body)', flexShrink: 0 }}>
                  <Calendar size={13} /> {formatDate('2026-08-03')}
                </div>
              </div>
            </div>

            {/* Review Card 3 */}
            <div style={{ background: '#F8F4F0', borderRadius: '24px', border: '1px solid #e4e4e7', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)', textAlign: 'left' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ width: 76, height: 76, backgroundColor: '#e4e4e7', border: '1px solid #cbd5e1', borderRadius: 12, overflow: 'hidden', flexShrink: 0 }}>
                  <img src="/nike air max.jpg" alt="Nike Air Max" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#161E2E', margin: '0 0 6px 0', wordBreak: 'break-word' }}>
                    Nike Air Max
                  </h3>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '9999px', padding: '2px 10px', color: '#0369a1', fontSize: '0.75rem', fontWeight: 600 }}>Nike</span>
                    <span style={{ backgroundColor: 'rgba(100, 116, 139, 0.1)', borderRadius: '9999px', padding: '2px 10px', color: '#475569', fontSize: '0.75rem', fontWeight: 500 }}>Footwear</span>
                  </div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    <StarRating rating={4} size={15} gap={3} />
                  </div>
                </div>
              </div>

              <p style={{ margin: 0, padding: '4px 0', lineHeight: 1.6, fontSize: '0.98rem', fontFamily: 'var(--font-body)', color: '#27272a' }}>
                "Great arch support for daily running. Bought online at a discount — feel free to DM for size tips!"
              </p>

              {/* Heart button right above horizontal rule */}
              <div style={{ display: 'flex', alignItems: 'center', margin: '0 0 2px 0' }}>
                <span
                  aria-label="8 likes"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                    padding: '3px 8px', color: '#52525b', fontSize: '0.75rem', fontWeight: 600
                  }}
                >
                  <Heart size={14} fill="none" color="#52525b" aria-hidden="true" />
                  <span aria-hidden="true">8</span>
                </span>
              </div>

              <div style={{ paddingTop: '16px', marginTop: '4px', borderTop: '1px solid #e4e4e7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#0369a1', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1rem', flexShrink: 0 }}>
                    A
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 5, margin: 0, color: '#161E2E' }}>
                      Aniket Verma <CheckCircle2 size={14} color="#0369a1" />
                    </p>
                    <p style={{ fontSize: '0.78rem', color: '#64748b', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MapPin size={12} color="#0369a1" /> Mumbai
                    </p>
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#71717a', display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-body)', flexShrink: 0 }}>
                  <Calendar size={13} /> {formatDate('2026-07-28')}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 5: Call to Action */}
        <section style={{ position: 'relative', zIndex: 2, padding: '160px 2rem 220px 2rem', maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <h2 className="landing-title" style={{ margin: '0 0 1.5rem 0' }}>
            Stop buying blindly. <br />
            <span style={{ color: '#0369a1', fontStyle: 'italic' }}>start connecting</span>
          </h2>
          <p style={{ color: '#475569', fontSize: '1.2rem', maxWidth: '680px', textAlign: 'center', margin: 0, lineHeight: 1.65 }}>
            Join thousands of real buyers sharing authentic product reviews and chatting in real-time.
          </p>
        </section>

        {/* Windora Dark Slate Navy Footer */}
        <footer id="contact" style={{
            position: 'relative',
            zIndex: 2,
            padding: '4rem 4rem 2rem 4rem',
            backgroundColor: '#161e2e',
            borderRadius: '32px 32px 0 0',
            maxWidth: 1240,
            margin: '0 auto',
            color: '#ffffff',
            fontFamily: 'var(--font-body)',
            boxSizing: 'border-box'
        }}>
            {/* Top Row: Logo & Description on Left, Email Subscription Input on Right */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '3rem', marginBottom: '3.5rem' }}>
                <div style={{ maxWidth: 420 }}>
                    <div
                        className="landing-dark-logo"
                        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                        style={{
                            color: '#ffffff',
                            marginBottom: '1.25rem',
                            fontSize: '2.2rem',
                            fontFamily: "'Rochester', cursive",
                            fontWeight: 650,
                            cursor: 'pointer'
                        }}
                    >
                         Reviewpedia
                    </div>
                    <p style={{ color: '#94a3b8', fontSize: '1rem', lineHeight: 1.6, margin: 0 }}>
                        Your own friendly neighbourhood social media platform, made in INDIA
                    </p>
                </div>

                {/* Right side: Email input + Cyan Circular Submit Button */}
                <div style={{ flex: 1, maxWidth: 520, minWidth: 300 }}>
                    <form
                      onSubmit={(e) => { e.preventDefault(); setShowEmailPrompt(true); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.2)', paddingBottom: '12px' }}
                    >
                        <input
                          type="email"
                          placeholder="Enter Your Email"
                          aria-label="Your email address, to start market research"
                          value={marketResearchEmail}
                          onChange={(e) => setMarketResearchEmail(e.target.value)}
                          style={{background: 'transparent', border: 'none', outline: 'none', color: '#ffffff', fontSize: '1.5rem', fontFamily: 'var(--font-body)', width: '100%', paddingRight: '16px' }}
                        />
                        <button
                          type="submit"
                          aria-label="Continue to market research"
                          style={{ width: 48, height: 48, borderRadius: '50%', background: '#0369a1',border: 'none', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'transform 0.2s, background-color 0.2s' }}
                          onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#075985'; e.currentTarget.style.transform = 'scale(1.05)'; }}
                          onMouseOut={(e) => { e.currentTarget.style.backgroundColor = '#0369a1'; e.currentTarget.style.transform = 'scale(1)'; }}
                        >
                            <ArrowUpRight size={22} color="#ffffff" />
                        </button>
                    </form>
                </div>
            </div>

            {/* Middle Section: Left Content (Browse/Explore) & Right Columns (PRODUCTS / COMPANY / CONTACT & ADDRESS) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '3rem', marginBottom: '3.5rem' }}>
                {/* Left Topics & Highlights */}
                <div style={{ flex: 1, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
                    <div>
                        <span style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 500, display: 'block', marginBottom: '4px' }}>Browse</span>
                        <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#ffffff', margin: 0, lineHeight: 1.4 }}>
                            Products, hardware, tech, appliances &amp; local services
                        </h3>
                    </div>
                    <div>
                        <span style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 500, display: 'block', marginBottom: '4px' }}>Explore</span>
                        <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#ffffff', margin: 0, lineHeight: 1.4 }}>
                            Real time geospatial data for market analysis &amp; demand statistics
                        </h3>
                    </div>
                </div>

                {/* Right Columns Container (Right-aligned) */}
                <div style={{ display: 'flex', gap: '4.5rem', flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
                    {/* Column 1: PRODUCTS */}
                    <div>
                        <div style={{ color: '#ffffff', fontWeight: 700, marginBottom: '1rem', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>PRODUCTS</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.88rem', color: '#94a3b8' }}>
                            <span style={{ cursor: 'pointer' }} {...pressable(() => navigate('/browse'))}>Browse reviews</span>
                            <span style={{ cursor: 'pointer' }} {...pressable(() => navigate('/chat'))}>Message</span>
                        </div>
                    </div>

                    {/* Column 2: COMPANY */}
                    <div>
                        <div style={{ color: '#ffffff', fontWeight: 700, marginBottom: '1rem', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>COMPANY</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.88rem', color: '#94a3b8' }}>
                            <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Partner</span>
                            <span style={{ cursor: 'pointer' }} {...pressable(() => setShowEmailPrompt(true))}>Market research</span>
                            <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Integrations</span>
                            <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Pricing</span>
                            <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Request Demo</span>
                        </div>
                    </div>

                    {/* Column 3: CONTACT & ADDRESS */}
                    <div style={{ maxWidth: 215 }}>
                        <div style={{ marginBottom: '1.75rem' }}>
                            <div style={{ color: '#ffffff', fontWeight: 700, marginBottom: '1rem', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CONTACT</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.88rem', color: '#94a3b8' }}>
                                <div>
                                    <a href="mailto:careers@reviewpedia.co.in" style={{ color: '#0ea5e9', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                                        <Mail size={13} color="#0369a1" style={{ flexShrink: 0 }} /> careers@reviewpedia.co.in
                                    </a>
                                    <span style={{ fontSize: '0.78rem', color: '#64748b', display: 'block', marginTop: '2px' }}>for career info</span>
                                </div>
                                <div style={{ marginTop: '4px' }}>
                                    <a href="mailto:support@reviewpedia.co.in" style={{ color: '#0ea5e9', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                                        <Mail size={13} color="#0369a1" style={{ flexShrink: 0 }} /> support@reviewpedia.co.in
                                    </a>
                                    <span style={{ fontSize: '0.78rem', color: '#64748b', display: 'block', marginTop: '2px' }}>for customer support</span>
                                </div>
                            </div>
                        </div>
                        <div>
                            <div style={{ color: '#ffffff', fontWeight: 700, marginBottom: '1rem', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ADDRESS</div>
                            <p style={{ color: '#94a3b8', fontSize: '0.88rem', lineHeight: 1.6, margin: 0, display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                <MapPin size={14} color="#0369a1" style={{ flexShrink: 0, marginTop: '3px' }} /> A-10, Sector-62, Noida, Uttar Pradesh, 201309, India
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Bar: Horizontal Separator + Left Legal Links + Right Circular Social Media Icons */}
            <div style={{ paddingTop: '2rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.5rem' }}>
                {/* Left Legal Text Links */}
                <div style={{ display: 'flex', gap: '1.75rem', fontSize: '0.88rem', color: '#94a3b8' }}>
                    <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Terms</span>
                    <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Privacy</span>
                    <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Cookies</span>
                    <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Legal</span>
                    <span title="Not available yet" style={{ cursor: 'default', opacity: 0.65 }}>Blogs</span>
                </div>

                {/* Right Social Media Icon Circles */}
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <a href="https://youtube.com" target="_blank" rel="noreferrer" style={{ width: 38, height: 38, borderRadius: '50%', background: '#F8F4F0', color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', transition: 'transform 0.2s' }} title="YouTube" aria-label="YouTube">
                        <Youtube size={18} />
                    </a>
                    <a href="https://linkedin.com" target="_blank" rel="noreferrer" style={{ width: 38, height: 38, borderRadius: '50%', background: '#F8F4F0', color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', transition: 'transform 0.2s' }} title="LinkedIn" aria-label="LinkedIn">
                        <Linkedin size={18} />
                    </a>
                    <a href="https://instagram.com" target="_blank" rel="noreferrer" style={{ width: 38, height: 38, borderRadius: '50%', background: '#F8F4F0', color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', transition: 'transform 0.2s' }} title="Instagram" aria-label="Instagram">
                        <Instagram size={18} />
                    </a>
                    <a href="https://facebook.com" target="_blank" rel="noreferrer" style={{ width: 38, height: 38, borderRadius: '50%', background: '#F8F4F0', color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', transition: 'transform 0.2s' }} title="Facebook" aria-label="Facebook">
                        <Facebook size={18} />
                    </a>
                </div>
            </div>
        </footer>

        {/* Existing Auth / Email Prompt overlay */}
        {showEmailPrompt && (
             <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: '20px', boxSizing: 'border-box' }}>
                 <div ref={emailPromptRef} role="dialog" aria-modal="true" aria-labelledby="email-prompt-title" tabIndex={-1} style={{ padding: '32px', display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', maxWidth: '440px', background: '#161E2E',border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '24px', boxShadow: 'none', color: '#ffffff', fontFamily: 'var(--font-body)', boxSizing: 'border-box' }}>
                     {/* Title Row with Cyan Icon Badge */}
                     <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                         <div style={{ width: '44px', height: '44px', borderRadius: '50%', backgroundColor: 'rgba(14, 165, 233, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                             <Mail size={22} color="#0369a1" />
                         </div>
                         <h2 id="email-prompt-title" style={{ margin: 0, fontSize: '1.35rem', color: '#ffffff', fontFamily: 'var(--font-display)', fontWeight: 600 }}>Identity Verification</h2>
                     </div>

                     {/* Subtitle / Description */}
                     <p style={{ fontSize: '0.92rem', color: '#94a3b8', margin: 0, lineHeight: 1.6 }}>
                         Enter your email address to securely route AI-generated intelligence briefings and automated sales outreach directly to your inbox for verification. Agent emails can only be delivered to the email address of your signed-in account.
                     </p>

                     {/* Input Box Container */}
                     <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                         <label htmlFor="market-research-email" style={{ fontSize: '0.78rem', color: '#ffffff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Work Email</label>
                         <input
                             id="market-research-email"
                             type="email"
                             value={marketResearchEmail}
                             onChange={(e) => setMarketResearchEmail(e.target.value)}
                             placeholder="you@example.com"
                             autoFocus
                             onKeyDown={(e) => e.key === 'Enter' && startBusinessMode()}
                             style={{ padding: '12px 16px', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '12px', background: '#1f293d', outline: 'none', fontSize: '0.95rem', fontFamily: 'var(--font-body)', transition: 'all 0.2s', color: '#ffffff', boxSizing: 'border-box' }}
                             onFocus={(e) => { e.target.style.borderColor = '#0ea5e9'; e.target.style.boxShadow = '0 0 0 3px rgba(14, 165, 233, 0.2)'; }}
                             onBlur={(e) => { e.target.style.borderColor = 'rgba(255, 255, 255, 0.12)'; e.target.style.boxShadow = 'none'; }}
                         />
                     </div>

                     {/* Equal Width Action Buttons */}
                     <div style={{ display: 'flex', gap: '12px', marginTop: '8px', alignItems: 'center' }}>
                         <button
                             onClick={() => setShowEmailPrompt(false)}
                             style={{
                                 flex: 1,
                                 height: '42px',
                                 background: '#161E2E',
                                 border: 'none',
                                 color: '#ffffff',
                                 borderRadius: '9999px',
                                 cursor: 'pointer',
                                 fontWeight: 600,
                                 fontSize: '0.88rem',
                                 display: 'flex',
                                 alignItems: 'center',
                                 justifyContent: 'center',
                                 transition: 'color 0.2s'
                             }}
                             onMouseOver={(e) => e.currentTarget.style.color = '#0ea5e9'}
                             onMouseOut={(e) => e.currentTarget.style.color = '#ffffff'}
                         >
                             Cancel
                         </button>
                         <button
                             onClick={startBusinessMode}
                             style={{
                                 flex: 1,
                                 height: '42px',
                                 background: '#0369a1',
                                 border: 'none',
                                 color: '#ffffff',
                                 borderRadius: '9999px',
                                 cursor: 'pointer',
                                 fontWeight: 600,
                                 fontSize: '0.88rem',
                                 display: 'flex',
                                 alignItems: 'center',
                                 justifyContent: 'center',
                                 gap: '8px',
                                 transition: 'background-color 0.2s'
                             }}
                             onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#075985'}
                             onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#0369a1'}
                         >
                             Initialize <ArrowRight size={16}/>
                         </button>
                     </div>
                 </div>
             </div>
        )}
        {/* The sign-in modal is rendered once, further down, for every page. A second
            copy here opened two overlapping dialogs on the landing page. */}
        </div>
      )}

      {/* Navigation Header for Consumer & Business Views */}
      {appMode !== 'landing' && appMode !== 'chat' && appMode !== 'myProfileSettings' && appMode !== 'reviewDetail' && (
        <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ position: 'relative', width: 'min(600px, calc(100vw - 40px))', margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
              <h1 style={{ position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
                Browse reviews on the map
              </h1>
              <header className="browse-topbar" style={{
                  width: 'min(600px, calc(100vw - 40px))', maxWidth: 'calc(100vw - 40px)', height: 64,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                  background: 'rgba(3, 3, 3, 0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderRadius: '9999px', border: 'none',
                  padding: '0 18px', boxShadow: 'none', color: '#ffffff', boxSizing: 'border-box'
              }}>
            {/* Left Group */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
                <button
                  style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'none', border: 'none', color: '#ffffff', transition: 'color 0.2s', padding: 0 }}
                  onClick={() => mapComponentRef.current?.locateUser()}
                  onMouseOver={(e) => {
                      e.currentTarget.style.color = '#0ea5e9';
                      const svg = e.currentTarget.querySelector('svg');
                      if (svg) svg.setAttribute('stroke', '#0ea5e9');
                  }}
                  onMouseOut={(e) => {
                      e.currentTarget.style.color = '#ffffff';
                      const svg = e.currentTarget.querySelector('svg');
                      if (svg) svg.setAttribute('stroke', '#ffffff');
                  }}
                  title="Locate Me"
                  aria-label="Locate me"
                >
                  <Crosshair size={20} color="currentColor" />
                </button>
            </div>

            {/* Center Group (Search with Category Dropdown) */}
            <div className="browse-search" style={{
              width: 350,
              maxWidth: '42vw',
              flex: '0 1 350px',
              height: 40,
              display: 'flex',
              alignItems: 'center',
              background: '#ffffff',
              borderRadius: '9999px',
              border: '1px solid #cbd5e1',
              boxSizing: 'border-box',
              position: 'relative'
            }}>
               {/* Left Category Dropdown Trigger */}
               <div ref={categoryDropdownRef} style={{ height: '100%', display: 'flex', alignItems: 'center' }}>
                 <button
                   type="button"
                   onClick={() => {
                     setIsCreatingReview(false);
                     setIsCategoryDropdownOpen(prev => !prev);
                   }}
                   style={{
                     height: '100%',
                     padding: '0 10px 0 16px',
                     display: 'flex',
                     alignItems: 'center',
                     gap: '5px',
                     background: 'transparent',
                     border: 'none',
                     borderRight: '1px solid #cbd5e1',
                     cursor: 'pointer',
                     color: '#1e293b',
                     fontWeight: 600,
                     fontSize: '0.86rem',
                     fontFamily: 'var(--font-body)',
                     borderTopLeftRadius: '9999px',
                     borderBottomLeftRadius: '9999px',
                     transition: 'background-color 0.15s ease',
                     userSelect: 'none',
                     flexShrink: 0
                   }}
                   onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'}
                   onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                   title={selectedCategory === 'All' ? 'All Categories' : selectedCategory}
                   aria-label={`Category: ${selectedCategory === 'All' ? 'All categories' : selectedCategory}`}
                   aria-haspopup="dialog"
                   aria-expanded={isCategoryDropdownOpen}
                 >
                   <span style={{ maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                     {selectedCategory}
                   </span>
                   <ChevronDown size={13} color="#475569" style={{ transition: 'transform 0.2s ease', transform: isCategoryDropdownOpen ? 'rotate(180deg)' : 'none', flexShrink: 0 }} />
                 </button>
               </div>

               {/* Search Input */}
               <input
                 type="text"
                 placeholder={selectedCategory === 'All' ? 'Search "Mobiles"' : `Search in ${selectedCategory}...`}
                 value={searchInput}
                 onChange={(e) => setSearchInput(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                 aria-label="Search reviews"
                 className="header-search-input"
                 style={{
                   border: 'none',
                   background: 'transparent',
                   outline: 'none',
                   flex: 1,
                   padding: '0 12px',
                   fontSize: '0.88rem',
                   fontFamily: 'var(--font-body)',
                   color: '#0f172a',
                   minWidth: 0
                 }}
               />

               {/* Search Button */}
               <button
                 onClick={handleSearch}
                 style={{
                   background: 'transparent',
                   border: 'none',
                   width: 32,
                   height: 32,
                   borderRadius: '50%',
                   display: 'flex',
                   alignItems: 'center',
                   justifyContent: 'center',
                   cursor: 'pointer',
                   flexShrink: 0,
                   marginRight: '4px',
                   padding: 0,
                   transition: 'background-color 0.15s ease'
                 }}
                 onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'}
                 onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                 title="Search"
                 aria-label="Search"
               >
                  <Search size={18} color="#000000" />
               </button>
            </div>

            {/* Right Group (User & Add Review) */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>

                {appMode === 'consumer' && (
                    <button
                        aria-label="Add a review"
                        aria-expanded={isCreatingReview}
                        style={{ height: 40, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: 'none', border: 'none', color: '#ffffff', transition: 'color 0.2s' }}
                        onMouseOver={(e) => {
                            e.currentTarget.style.color = '#0ea5e9';
                            const svg = e.currentTarget.querySelector('svg');
                            if (svg) svg.setAttribute('stroke', '#0ea5e9');
                            const span = e.currentTarget.querySelector('span');
                            if (span) span.style.color = '#0ea5e9';
                        }}
                        onMouseOut={(e) => {
                            e.currentTarget.style.color = '#ffffff';
                            const svg = e.currentTarget.querySelector('svg');
                            if (svg) svg.setAttribute('stroke', '#ffffff');
                            const span = e.currentTarget.querySelector('span');
                            if (span) span.style.color = '#ffffff';
                        }}
                        onClick={() => {
                            if (!user) setShowAuthModal('login');
                            else {
                                setEditingReviewData(null);
                                setIsCategoryDropdownOpen(false);
                                setIsCreatingReview(prev => !prev);
                            }
                        }}
                    >
                        <Plus size={18} color="currentColor" /> <span className="browse-add-label" style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff', whiteSpace: 'nowrap', transition: 'color 0.2s' }}>Add a review</span>
                    </button>
                )}
                {appMode === 'business' && (
                    <>
                        <button
                            style={{ height: 40, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: 'none', border: 'none', color: '#ffffff', transition: 'color 0.2s' }}
                            onMouseOver={(e) => {
                                e.currentTarget.style.color = '#0ea5e9';
                                const span = e.currentTarget.querySelector('span');
                                if (span) span.style.color = '#0ea5e9';
                            }}
                            onMouseOut={(e) => {
                                e.currentTarget.style.color = '#ffffff';
                                const span = e.currentTarget.querySelector('span');
                                if (span) span.style.color = '#ffffff';
                            }}
                            onClick={() => setIsAgentOpen(prev => !prev)}
                        >
                            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff', whiteSpace: 'nowrap', transition: 'color 0.2s' }}>Open Agent Window</span>
                        </button>
                        <button
                            style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'none', border: 'none', color: '#ffffff', padding: 0, transition: 'color 0.2s' }}
                            onClick={() => setIsHexagonSettingsOpen(prev => !prev)}
                            onMouseOver={(e) => {
                                e.currentTarget.style.color = '#0ea5e9';
                                const svg = e.currentTarget.querySelector('svg');
                                if (svg) svg.setAttribute('stroke', '#0ea5e9');
                            }}
                            onMouseOut={(e) => {
                                e.currentTarget.style.color = '#ffffff';
                                const svg = e.currentTarget.querySelector('svg');
                                if (svg) svg.setAttribute('stroke', '#ffffff');
                            }}
                            title="Toggle Hexagon Size"
                            aria-label="Hexagon size"
                            aria-expanded={isHexagonSettingsOpen}
                        >
                            <Hexagon size={18} color="currentColor" />
                        </button>
                    </>
                )}
            </div>
          </header>
          {isHexagonSettingsOpen && appMode === 'business' && (
             <div style={{ position: 'absolute', left: 'calc(100% + 8px)', top: 0, width: 125, padding: '12px', background: 'rgba(3, 3, 3, 0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderRadius: '16px', border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', boxShadow: 'none', color: '#ffffff' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-body)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', marginBottom: '8px', whiteSpace: 'nowrap', color: '#ffffff' }}>
                    Hexagon Size
                    <span style={{ color: '#ffffff', opacity: 0.8 }}>Lvl {hexResolution}</span>
                </label>

                <span style={{ fontSize: '0.7rem', color: '#ffffff', fontFamily: 'var(--font-body)', marginBottom: '-4px', opacity: 0.8 }}>Massive</span>

                <div style={{ height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <input
                        type="range"
                        min="3"
                        max="10"
                        aria-label="Hexagon size level (3 largest, 10 smallest)"
                        value={hexResolution}
                        onChange={(e) => setHexResolution(parseInt(e.target.value))}
                        className="hexagon-range"
                        style={{
                            width: '120px',
                            transform: 'rotate(90deg)',
                            background: `linear-gradient(to right, var(--primary) ${((hexResolution - 3) / 7) * 100}%, rgba(255, 255, 255, 0.1) ${((hexResolution - 3) / 7) * 100}%)`
                        }}
                    />
                </div>

                <span style={{ fontSize: '0.7rem', color: '#ffffff', fontFamily: 'var(--font-body)', marginTop: '-4px', opacity: 0.8 }}>Tiny</span>
             </div>
          )}
          </div>

          {/* Category Dropdown Modal */}
          {isCategoryDropdownOpen && (
            <CategorySelectModal
              ref={categoryBoxRef}
              selectedCategory={selectedCategory}
              onSelectCategory={handleCategorySelect}
              onClose={() => setIsCategoryDropdownOpen(false)}
            />
          )}

          <div style={{ display: isCreatingReview ? 'block' : 'none', width: '100%' }}>
              <CreateReview
                  key={editingReviewData ? `edit-${editingReviewData.id}` : `create-${mapUpdateTrigger}`}
                  editingReview={editingReviewData}
                  onClose={() => {
                      setIsCreatingReview(false);
                      setEditingReviewData(null);
                  }}
                  onPostSuccess={() => {
                      setIsCreatingReview(false);
                      setEditingReviewData(null);
                      setMapUpdateTrigger(prev => prev + 1);
                      setSelectedLocationReviews(null);
                  }}
              />
          </div>
        </div>
      )}

      {/* Top Left: Back Button for Browse / Map views */}
      {appMode !== 'landing' && appMode !== 'chat' && appMode !== 'myProfileSettings' && appMode !== 'reviewDetail' && (
          <div className="browse-corner browse-corner-left" style={{ position: 'absolute', top: 32, left: 30, zIndex: 900 }}>
              <button
                  onClick={() => {
                      if (window.history.length > 2) navigate(-1);
                      else navigate('/');
                  }}
                  onMouseEnter={() => setIsBrowseBackHovered(true)}
                  onMouseLeave={() => setIsBrowseBackHovered(false)}
                  style={{
                      height: 40,
                      padding: '0 20px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      backgroundColor: '#F8F4F0',
                      border: '1px solid #e5e0da',
                      color: isBrowseBackHovered ? '#0369a1' : '#334155',
                      borderRadius: '9999px',
                      fontWeight: 600,
                      fontSize: '0.88rem',
                      fontFamily: 'var(--font-body)',
                      cursor: 'pointer',
                      transition: 'color 0.15s ease'
                  }}
                  title="Back"
              >
                  <ArrowLeft size={18} color={isBrowseBackHovered ? '#0369a1' : '#334155'} />
                  <span>Back</span>
              </button>
          </div>
      )}

      {appMode !== 'landing' && appMode !== 'chat' && appMode !== 'myProfileSettings' && appMode !== 'reviewDetail' && !user && (
          <div className="browse-corner browse-corner-right" style={{ position: 'absolute', top: 32, right: 30, zIndex: 1001 }}>
              <button
                  style={{
                      height: 40, padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      cursor: 'pointer', background: '#0369a1', border: 'none', color: '#ffffff',
                      borderRadius: '9999px', fontWeight: 600, fontSize: '0.88rem', fontFamily: 'var(--font-body)',
                      transition: 'background-color 0.2s', boxShadow: 'none'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#075985'}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#0369a1'}
                  onClick={() => setShowAuthModal('login')}
              >
                  Sign In
              </button>
          </div>
      )}

      {appMode !== 'landing' && appMode !== 'chat' && appMode !== 'myProfileSettings' && appMode !== 'reviewDetail' && user && (
          <div className="browse-corner browse-corner-right" style={{ position: 'absolute', top: 32, right: 30, zIndex: 1001, display: 'flex', alignItems: 'center', gap: '14px' }}>
             <ChatIcon unreadCount={unreadChatCount} color="#000000" fillColor="#F8F4F0" hoverColor="#0369a1" size={22} onClick={() => navigate('/chat')} />
             <NotificationIcon unreadCount={0} color="#000000" fillColor="#F8F4F0" hoverColor="#0369a1" size={22} />
             <div className="nav-dropdown" style={{ height: '40px', width: '40px' }}>
                {/* The dropdown menu, positioned to align with header top (top: 20 -> relative top: -12) */}
                <div className="nav-dropdown-menu" style={{ top: '-12px', right: '-12px', left: 'auto', minWidth: '160px', borderRadius: '16px', border: 'none', padding: '12px', zIndex: 1, boxShadow: 'none' }}>
                    {/* First row: My Profile with padding to not overlap the photo */}
                    <div {...pressable(() => navigate('/profile'))} style={{ padding: '0 12px', paddingRight: '48px',cursor: 'pointer', height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>My Profile</span>
                    </div>

                    {/* Second row: My Reviews */}
                    <div {...pressable(handleOpenMyReviews)} style={{ padding: '0 12px', cursor: 'pointer',height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>My Reviews</span>
                    </div>

                    <hr style={{ border: 'none', borderTop: '1px solid rgba(255, 255, 255, 0.08)', margin: '4px 0', padding: 0 }} />

                    {/* Third row: Sign Out */}
                    <div {...pressable(logout)} className="nav-logout-item" style={{padding: '0 12px', cursor: 'pointer', height: '36px', display: 'flex', alignItems: 'center', boxSizing: 'border-box' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Sign Out</span>
                    </div>
                </div>

                {/* The profile photo, rendered ON TOP of the menu. Focusing it opens the
                    menu (see .nav-dropdown:focus-within); Enter or the down arrow moves into it. */}
                <div
                    role="button"
                    tabIndex={0}
                    aria-haspopup="menu"
                    aria-label="Account menu"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                            e.preventDefault();
                            e.currentTarget.parentElement?.querySelector('[role="button"]')?.focus();
                        }
                    }}
                    style={{ position: 'relative', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px', borderRadius: '50%' }}
                >
                    {user.profilePic ? (
                        <img
                            src={user.profilePic}
                            alt="Profile"
                            style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', display: 'block', cursor: 'pointer', border: '3px solid #0ea5e9', boxSizing: 'border-box', boxShadow: 'none' }}
                        />
                    ) : (
                        <div style={{
                           width: '40px', height: '40px', borderRadius: '50%',
                           backgroundColor: '#0369a1', color: 'white',
                           display: 'flex', alignItems: 'center', justifyContent: 'center',
                           fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                           border: '3px solid #0ea5e9', boxSizing: 'border-box',
                           boxShadow: 'none'
                        }}>
                            {user.username.charAt(0).toUpperCase()}
                        </div>
                    )}
                </div>
             </div>
          </div>
      )}

      {appMode === 'business' && <AgentBox demoEmail={marketResearchEmail} isOpen={isAgentOpen} onClose={() => setIsAgentOpen(false)} />}

      {appMode === 'consumer' && selectedLocationReviews && (
        <MultiReviewCard
          reviews={selectedLocationReviews}
          totalCount={reviewPaging?.kind === 'location' ? reviewPaging.total : undefined}
          hasMore={reviewPaging?.kind === 'location' && !!reviewPaging.nextCursor}
          loadingMore={!!reviewPaging?.loading}
          onLoadMore={handleLoadMoreReviews}
          onClose={() => setSelectedLocationReviews(null)}
          onUserClick={(u, userObj) => { setSelectedUser(userObj || u); }}
          currentUser={user}
          onDeleteSuccess={(deletedId) => {
            const remaining = selectedLocationReviews.filter(r => r.id !== deletedId);
            if (remaining.length === 0) setSelectedLocationReviews(null);
            else setSelectedLocationReviews(remaining);
            noteReviewDeleted();
            setMapUpdateTrigger(prev => prev + 1);
          }}
          onEdit={(rev) => {
            setEditingReviewData(rev);
            setIsCreatingReview(true);
          }}
          onLikeToggle={handleLikeToggle}
        />
      )}

      {appMode === 'consumer' && isMyReviewsOpen && (
        <MultiReviewCard
          reviews={myReviewsList}
          isMyReviews={true}
          totalCount={reviewPaging?.kind === 'mine' ? reviewPaging.total : undefined}
          hasMore={reviewPaging?.kind === 'mine' && !!reviewPaging.nextCursor}
          loadingMore={!!reviewPaging?.loading}
          onLoadMore={handleLoadMoreReviews}
          onClose={() => setIsMyReviewsOpen(false)}
          onUserClick={(u, userObj) => { setSelectedUser(userObj || u); }}
          currentUser={user}
          onDeleteSuccess={(deletedId) => {
            const remaining = myReviewsList.filter(r => r.id !== deletedId);
            setMyReviewsList(remaining);
            noteReviewDeleted();
            setMapUpdateTrigger(prev => prev + 1);
          }}
          onEdit={(rev) => {
            setEditingReviewData(rev);
            setIsCreatingReview(true);
          }}
          onLikeToggle={handleLikeToggle}
        />
      )}

      {selectedUser && (
        <UserProfile
            username={typeof selectedUser === 'object' ? (selectedUser.name || selectedUser.username) : selectedUser}
            userProfilePic={typeof selectedUser === 'object' ? selectedUser.profilePic : null}
            onClose={() => setSelectedUser(null)}
            // No "Chat with" button on your own profile (the server refuses a chat with yourself).
            onChatClick={user && (typeof selectedUser === 'object' ? (selectedUser.name || selectedUser.username) : selectedUser) === user.username ? undefined : () => {
                const targetUsername = typeof selectedUser === 'object' ? (selectedUser.name || selectedUser.username) : selectedUser;
                if (!user) {
                    setShowAuthModal('login');
                } else {
                    setInitialChatUser(targetUsername);
                    setSelectedUser(null);
                    navigate('/chat');
                }
            }}
        />
      )}



      {showAuthModal && <AuthModal initialMode={showAuthModal} onClose={() => setShowAuthModal(false)} />}

      {appMode === 'chat' && user && (
          <ChatApp
              currentUser={user}
              onClose={() => {
                  navigate('/');
                  setInitialChatUser(null);
              }}
              initialChatUser={initialChatUser}
              onInitialChatHandled={() => setInitialChatUser(null)}
          />
      )}

      {/* Chat and profile need an account. While the session is being checked show a
          loader; once it is known there is no user, say so instead of a blank page. */}
      {(appMode === 'chat' || appMode === 'myProfileSettings') && !user && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#F8F4F0', padding: 24, textAlign: 'center', fontFamily: 'var(--font-body)' }}>
          {authLoading ? (
            <p style={{ color: '#475569', margin: 0 }}>Loading…</p>
          ) : (
            <>
              <h2 style={{ margin: 0, color: '#0f172a' }}>Please sign in</h2>
              <p style={{ color: '#475569', margin: 0 }}>You need an account to {appMode === 'chat' ? 'use chat' : 'view your profile'}.</p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => setShowAuthModal('login')} style={{ padding: '10px 22px', borderRadius: 9999, border: 'none', background: '#0369a1', color: '#ffffff', fontWeight: 600, cursor: 'pointer' }}>Sign In</button>
                <button onClick={() => navigate('/')} style={{ padding: '10px 22px', borderRadius: 9999, border: '1px solid #cbd5e1', background: '#ffffff', color: '#0f172a', fontWeight: 600, cursor: 'pointer' }}>Back to home</button>
              </div>
            </>
          )}
        </div>
      )}

      {appMode === 'myProfileSettings' && user && (
        <MyProfilePage
           user={user}
           onBack={() => navigate('/')}
           onUserUpdate={(updatedUser) => setUser(updatedUser)}
           onDeleteAccount={() => {
             logout();
             navigate('/');
           }}
        />
      )}

      {appMode === 'reviewDetail' && (
        <ReviewDetailPage
          currentUser={user}
          logout={logout}
          onOpenAuth={(mode) => setShowAuthModal(mode || 'login')}
          onLikeToggle={handleLikeToggle}
          onUserClick={(u, userObj) => setSelectedUser(userObj || u)}
        />
      )}

    </div>
  );
}

export default App;
