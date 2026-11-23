import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

import { API_BASE_URL } from '../config';
import { getAuthHeaders, setAuthToken, removeAuthToken, errorMessage, readJson, watchSessionExpiry } from '../utils/apiUtils';
import { notify } from '../utils/notify';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const API_URL = API_BASE_URL;

    useEffect(() => {
        // Fetch current user on mount using cookies + Authorization header fallback
        const fetchUser = async () => {
            try {
                const response = await fetch(`${API_URL}/api/auth/me`, { 
                    headers: { ...getAuthHeaders() },
                    credentials: 'include' 
                });
                const data = await response.json().catch(() => ({}));
                if (response.ok && data.success && data.user) {
                    setUser(data.user);
                } else {
                    setUser(null);
                    // Only a real "not authenticated" answer invalidates the stored
                    // token. A rate limit (429) or server error must not log the user out.
                    if (response.status === 401) removeAuthToken();
                }
            } catch (err) {
                console.log('Not authenticated');
                setUser(null);
            } finally {
                setLoading(false);
            }
        };
        fetchUser();
    }, [API_URL]);

    // A 401 on any signed-in request means the session ended (token expired,
    // password reset elsewhere, account deleted): sign out locally and say so.
    const userRef = useRef(null);
    userRef.current = user;
    useEffect(() => watchSessionExpiry(() => {
        removeAuthToken();
        if (userRef.current) {
            notify('Your session has ended. Please sign in again.', { type: 'info' });
        }
        setUser(null);
    }), []);

    const login = async (email, password) => {
        const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            if (data.token) {
                setAuthToken(data.token);
            }
            setUser(data.user);
            return true;
        }
        throw new Error(errorMessage(data, 'Login failed'));
    };

    const sendSignupOtp = async (email, username) => {
        const res = await fetch(`${API_URL}/api/auth/send-signup-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, username }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            return true;
        }
        throw new Error(errorMessage(data, 'Failed to send verification code'));
    };

    const register = async (username, email, password, otp) => {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password, otp }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            if (data.token) {
                setAuthToken(data.token);
            }
            setUser(data.user);
            return true;
        }
        throw new Error(errorMessage(data, 'Registration failed'));
    };

    const sendEmailUpdateOtp = async (newEmail) => {
        const res = await fetch(`${API_URL}/api/auth/send-email-update-otp`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({ newEmail }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            return true;
        }
        throw new Error(errorMessage(data, 'Failed to send verification code'));
    };

    const sendForgotPasswordOtp = async (email) => {
        const res = await fetch(`${API_URL}/api/auth/send-forgot-password-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            return true;
        }
        throw new Error(errorMessage(data, 'Failed to send password reset code'));
    };

    const resetPassword = async (email, otp, newPassword) => {
        const res = await fetch(`${API_URL}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp, newPassword }),
            credentials: 'include'
        });
        const data = await readJson(res);
        if (data.success) {
            if (data.token) {
                setAuthToken(data.token);
            }
            setUser(data.user);
            return true;
        }
        throw new Error(errorMessage(data, 'Failed to reset password'));
    };

    const logout = async () => {
        try {
            await fetch(`${API_URL}/api/auth/logout`, { 
                method: 'POST', 
                headers: { ...getAuthHeaders() },
                credentials: 'include' 
            });
        } catch (e) {
            console.error('Logout error:', e);
        } finally {
            removeAuthToken();
            setUser(null);
        }
    };

    return (
        <AuthContext.Provider value={{ 
            user, 
            setUser, 
            loading, 
            login, 
            register, 
            sendSignupOtp, 
            sendEmailUpdateOtp, 
            sendForgotPasswordOtp, 
            resetPassword, 
            logout 
        }}>
            {children}
        </AuthContext.Provider>
    );
};
