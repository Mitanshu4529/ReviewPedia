import React, { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config';
import { X, MessageCircle, Star } from 'lucide-react';
import { useModalA11y } from '../utils/a11y';

export default function UserProfile({ username, userProfilePic, onClose, onChatClick }) {
  const [profilePic, setProfilePic] = useState(userProfilePic || null);
  const [profile, setProfile] = useState({ status: 'loading', reviewCount: 0, recentReviews: [], memberSince: null });

  useEffect(() => {
    if (!username) return undefined;
    const controller = new AbortController();
    setProfile(prev => ({ ...prev, status: 'loading' }));

    fetch(`${API_BASE_URL}/api/auth/user/${encodeURIComponent(username)}`, { signal: controller.signal })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => {
        if (!data.success) throw new Error('Profile not found');
        if (data.user?.profilePic) setProfilePic(data.user.profilePic);
        setProfile({
          status: 'ready',
          reviewCount: data.reviewCount || 0,
          recentReviews: Array.isArray(data.recentReviews) ? data.recentReviews : [],
          memberSince: data.user?.createdAt || null
        });
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        // Imported reviewers have no account, so there is simply nothing to show.
        setProfile({ status: 'unavailable', reviewCount: 0, recentReviews: [], memberSince: null });
      });

    return () => controller.abort();
  }, [username]);

  const dialogRef = useModalA11y(onClose);

  const memberSince = profile.memberSince
    ? new Date(profile.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      backgroundColor: 'rgba(26, 28, 28, 0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)'
    }}>
      <div ref={dialogRef} tabIndex={-1} className="glass-panel" role="dialog" aria-modal="true" aria-label={`Profile of ${username}`} style={{width: 450, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: '32px', background: 'var(--surface-lowest)', position: 'relative', overflowY: 'auto', maxHeight: '90vh' }}>
        <button onClick={onClose} aria-label="Close profile" style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)' }}><X size={24} /></button>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginBottom: 32 }}>
            {profilePic ? (
                <img
                    src={profilePic}
                    alt={username}
                    style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover', boxShadow: 'none' }}
                />
            ) : (
                <div style={{ width: 88, height: 88, borderRadius: '50%', backgroundColor: 'var(--surface-highest)', color: 'var(--primary-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '2.5rem', fontFamily: 'var(--font-display)' }}>
                   {username ? username[0].toUpperCase() : '?'}
                </div>
            )}
            <div style={{ textAlign: 'center' }}>
                <h2 style={{ fontSize: '1.75rem', margin: 0, overflowWrap: 'anywhere' }}>{username}</h2>
                {profile.status === 'ready' && (
                  <div className="tonal-panel" style={{ display: 'flex', gap: '20px', marginTop: '16px', justifyContent: 'center', flexWrap: 'wrap', fontSize: '0.875rem', padding: '12px 24px', borderRadius: '9999px', fontFamily: 'var(--font-body)' }}>
                      <div style={{ color: 'var(--on-surface-variant)' }}>
                        <span style={{ color: 'var(--on-surface)', fontWeight: 600 }}>{profile.reviewCount}</span> {profile.reviewCount === 1 ? 'Review' : 'Reviews'}
                      </div>
                      {memberSince && <div style={{ color: 'var(--on-surface-variant)' }}>Member since {memberSince}</div>}
                  </div>
                )}
            </div>
        </div>

        {profile.status === 'ready' && onChatClick && (
          <div style={{ display: 'flex', gap: 10, marginBottom: '32px' }}>
              <button onClick={onChatClick} className="btn-primary" style={{ flex: 1, padding: '14px', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer' }}>
                  <MessageCircle size={18} /> Chat with {username}
              </button>
          </div>
        )}

        <div>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '20px', paddingBottom: '12px', color: 'var(--on-surface)' }}>Recent Reviews</h3>
            {profile.status === 'loading' && (
              <p style={{ color: 'var(--on-surface-variant)', fontFamily: 'var(--font-body)' }}>Loading…</p>
            )}
            {profile.status === 'unavailable' && (
              <p style={{ color: 'var(--on-surface-variant)', fontFamily: 'var(--font-body)' }}>
                This reviewer does not have a Reviewpedia account, so no profile is available.
              </p>
            )}
            {profile.status === 'ready' && profile.recentReviews.length === 0 && (
              <p style={{ color: 'var(--on-surface-variant)', fontFamily: 'var(--font-body)' }}>No reviews yet.</p>
            )}
            {profile.status === 'ready' && profile.recentReviews.map(review => (
                <div key={review.id} className="tonal-panel" style={{ padding: '20px', marginBottom: '16px' }}>
                    <h4 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 8px 0', color: 'var(--on-surface)', overflowWrap: 'anywhere' }}>{review.productName}</h4>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
                        {review.rating !== null && (
                          <span className="chip" style={{ backgroundColor: 'var(--surface-lowest)', padding: '2px 8px', color: 'var(--on-surface-variant)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Star size={12} /> {review.rating} / 5
                          </span>
                        )}
                        {review.category && (
                          <span className="chip" style={{ backgroundColor: 'var(--surface-lowest)', padding: '2px 8px', color: 'var(--on-surface-variant)' }}>{review.category}</span>
                        )}
                    </div>
                    {review.text && (
                      <p style={{ fontSize: '0.95rem', lineHeight: 1.5, fontFamily: 'var(--font-body)', color: 'var(--on-surface)', margin: 0, overflowWrap: 'anywhere' }}>"{review.text}"</p>
                    )}
                </div>
            ))}
        </div>
      </div>
    </div>
  );
}
