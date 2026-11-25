import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Profile } from '@/types/database';

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  session: Session | null;
  isLoading: boolean;
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string, schoolName?: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  updateProfile: (updates: Partial<Profile>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Helper for timeout on promises
function withTimeout<T>(promiseLike: Promise<T> | PromiseLike<T>, ms = 6000): Promise<T> {
  const promise = Promise.resolve(promiseLike);
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Network request timed out. Please check your internet connection.')), ms))
  ]);
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchProfile = async (currentUser: User): Promise<Profile | null> => {
    try {
      const { data, error } = await withTimeout<any>(
        supabase
          .from('profiles')
          .select('*')
          .eq('id', currentUser.id)
          .single(),
        4000
      );

      if (!error && data) {
        setProfile(data);
        return data;
      }
    } catch (e) {
      console.warn('Profile fetch note:', e);
    }

    // Fallback profile from user metadata if database row is newly created
    const fallbackProfile: Profile = {
      id: currentUser.id,
      email: currentUser.email || '',
      full_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Educator',
      school_name: currentUser.user_metadata?.school_name || null,
      avatar_url: null,
      created_at: currentUser.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setProfile(fallbackProfile);
    return fallbackProfile;
  };

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        const { data: { session: currentSession }, error } = await withTimeout(supabase.auth.getSession(), 4000);
        if (error) throw error;

        if (mounted && currentSession?.user) {
          setSession(currentSession);
          setUser(currentSession.user);
          await fetchProfile(currentSession.user);
        } else if (mounted) {
          setSession(null);
          setUser(null);
          setProfile(null);
        }
      } catch (e) {
        console.warn('Supabase session initialization notice:', e);
        if (mounted) {
          setSession(null);
          setUser(null);
          setProfile(null);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    initAuth();

    // Setup listener for real-time authentication events (login, logout, token refresh)
    const { data } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!mounted) return;
      if (newSession?.user) {
        setSession(newSession);
        setUser(newSession.user);
        await fetchProfile(newSession.user);
      } else {
        setSession(null);
        setUser(null);
        setProfile(null);
      }
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const { data, error } = await withTimeout(
      supabase.auth.signInWithPassword({ email: cleanEmail, password }),
      6000
    );

    if (error) {
      throw error;
    }

    if (data?.user && data?.session) {
      setSession(data.session);
      setUser(data.user);
      await fetchProfile(data.user);
    }
  };

  const signUp = async (email: string, password: string, fullName: string, schoolName?: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();
    const cleanSchool = schoolName?.trim() || null;

    const { data, error } = await withTimeout(
      supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: { full_name: cleanName, school_name: cleanSchool }
        }
      }),
      6000
    );

    if (error) {
      throw error;
    }

    if (data?.user) {
      setUser(data.user);
      if (data.session) {
        setSession(data.session);
      }
      try {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          email: cleanEmail,
          full_name: cleanName,
          school_name: cleanSchool,
        });
      } catch (e) {
        console.warn('Profiles table upsert note:', e);
      }
      await fetchProfile(data.user);
    }
  };

  const signOut = async () => {
    setUser(null);
    setProfile(null);
    setSession(null);
    try {
      await withTimeout(supabase.auth.signOut(), 3000);
    } catch (e) {
      console.warn('Sign out notice:', e);
    }
  };

  const resetPassword = async (email: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const { error } = await withTimeout(supabase.auth.resetPasswordForEmail(cleanEmail), 5000);
    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await withTimeout(supabase.auth.updateUser({ password: newPassword }), 5000);
    if (error) throw error;
  };

  const updateProfile = async (updates: Partial<Profile>) => {
    if (!user) throw new Error('Not authenticated');

    if (profile) {
      setProfile({ ...profile, ...updates, updated_at: new Date().toISOString() });
    }

    const { error } = await withTimeout<any>(
      supabase.from('profiles').update(updates).eq('id', user.id),
      5000
    );

    if (error) {
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      session,
      isLoading,
      isConfigured: isSupabaseConfigured,
      signIn,
      signUp,
      signOut,
      resetPassword,
      updatePassword,
      updateProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
