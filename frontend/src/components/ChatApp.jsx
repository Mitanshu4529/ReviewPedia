import React, { useState, useEffect, useCallback } from 'react';

import { API_BASE_URL } from '../config';
import ChatSidebar from './ChatSidebar';
import ChatWindow from './ChatWindow';
import LoadingPopup from './LoadingPopup';
import { getAuthHeaders, getJsonAuthHeaders, errorMessage, readJson } from '../utils/apiUtils';
import { useChat } from '../context/ChatContext';
import { notify } from '../utils/notify';

export default function ChatApp({ currentUser, onClose, initialChatUser, onInitialChatHandled }) {
    const [conversations, setConversations] = useState([]);
    const [isLoadingConversations, setIsLoadingConversations] = useState(true);
    const [activeConversation, setActiveConversation] = useState(null);
    // One realtime connection per signed-in user, shared with the rest of the app
    // (this page used to open a second socket of its own).
    const { markConversationRead, refreshUnreadCount, socket } = useChat();

    const fetchConversations = useCallback(async (showLoading = false) => {
        if (showLoading) setIsLoadingConversations(true);
        try {
            const API_URL = API_BASE_URL;
            const res = await fetch(`${API_URL}/api/chat/conversations`, { 
                headers: getAuthHeaders(),
                credentials: 'include' 
            });
            const data = await res.json();
            if (data.success) {
                setConversations(data.conversations);
            }
        } catch (e) {
            console.error("Failed to fetch conversations", e);
        } finally {
            setIsLoadingConversations(false);
        }
    }, []);

    // Keep the sidebar (last message, unread badges) current. Marking the open
    // conversation as read is done by ChatWindow, which shows the new message.
    useEffect(() => {
        if (!socket) return;
        const refresh = () => fetchConversations();
        socket.on('receive_message', refresh);
        socket.on('messages_read', refresh);
        socket.on('message_deleted', refresh);
        return () => {
            socket.off('receive_message', refresh);
            socket.off('messages_read', refresh);
            socket.off('message_deleted', refresh);
        };
    }, [socket, fetchConversations]);

    useEffect(() => {
        fetchConversations(true);
    }, [fetchConversations]);

    const handleSelectConversation = (convo) => {
        setActiveConversation(convo);
        if (convo && convo._id) {
            // Optimistically mark this conversation as read in the sidebar state
            setConversations(prev => prev.map(c => c._id === convo._id ? { ...c, unreadCount: 0 } : c));
            markConversationRead(convo._id);
        }
    };

    const startConversation = async (targetUsername) => {
        try {
            const API_URL = API_BASE_URL;
            const res = await fetch(`${API_URL}/api/chat/conversations`, {
                method: 'POST',
                headers: getJsonAuthHeaders(),
                credentials: 'include',
                body: JSON.stringify({ targetUsername })
            });
            const data = await readJson(res);
            if (res.ok && data.success) {
                setActiveConversation(data.conversation);
                fetchConversations();
            } else {
                notify(errorMessage(data, `Could not open a chat with ${targetUsername}.`));
            }
        } catch (e) {
            console.error("Failed to start conversation", e);
            notify('Could not open the chat. Please check your connection and try again.');
        }
    };

    // Open the chat requested from a profile once, then forget the request so a
    // later visit to /chat does not reopen it.
    useEffect(() => {
        if (initialChatUser) {
            startConversation(initialChatUser);
            onInitialChatHandled?.();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialChatUser]);

    const handleConversationDeleted = () => {
        setActiveConversation(null);
        fetchConversations(false);
        refreshUnreadCount();
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            backgroundColor: '#161E2E', zIndex: 9000, display: 'flex'
        }}>
            <LoadingPopup message={isLoadingConversations ? "Loading chats..." : null} zIndex={9999} />
            <ChatSidebar 
                conversations={conversations} 
                activeConversation={activeConversation}
                onSelectConversation={handleSelectConversation}
                onClose={onClose}
                currentUser={currentUser}
                isLoading={isLoadingConversations}
            />
            {activeConversation ? (
                <ChatWindow
                    // A fresh window per conversation: a draft, attachments or a late
                    // response from the previous chat must not carry over.
                    key={activeConversation._id}
                    conversation={activeConversation} 
                    currentUser={currentUser} 
                    socket={socket} 
                    onMessageSent={fetchConversations}
                    onConversationDeleted={handleConversationDeleted}
                />
            ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#161E2E', fontFamily: 'var(--font-body)' }}>
                    <div style={{ textAlign: 'center', padding: '0 24px' }}>
                        <h2 style={{ fontFamily: 'var(--font-display)', color: '#ffffff', fontSize: '1.8rem', fontWeight: 600, margin: '0 0 16px 0', letterSpacing: '-0.02em' }}>
                            Your Messages
                        </h2>
                        <p style={{ fontFamily: 'var(--font-body)', color: '#94a3b8', fontSize: '0.95rem', lineHeight: 1.8, margin: 0, maxWidth: 360 }}>
                            Select a conversation or start a new one to begin chatting with local reviewers.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
