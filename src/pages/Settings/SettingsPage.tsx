import React, { useState } from 'react';
import { 
  Settings, 
  Database, 
  User, 
  Copy, 
  Check, 
  ExternalLink, 
  Save, 
  RotateCcw,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  Lock
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/contexts/AuthContext';
import { isSupabaseConfigured, supabase, testSupabaseConnection } from '@/lib/supabase';

export const SettingsPage: React.FC = () => {
  const { profile, updateProfile, updatePassword, isConfigured } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name || 'Dr. Evelyn Reed');
  const [schoolName, setSchoolName] = useState(profile?.school_name || 'Horizon Science Academy');
  const [saving, setSaving] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Password state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordUpdating, setPasswordUpdating] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    try {
      setPasswordUpdating(true);
      await updatePassword(newPassword);
      setPasswordSuccess(true);
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordSuccess(false), 4000);
    } catch (err: any) {
      setPasswordError(err.message || 'Error updating password.');
    } finally {
      setPasswordUpdating(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      await updateProfile({
        full_name: fullName,
        school_name: schoolName,
      });
      alert('Profile updated successfully!');
    } catch (err: any) {
      alert('Error updating profile: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestSupabase = async () => {
    try {
      setTesting(true);
      const res = await testSupabaseConnection();
      setTestResult(res.message);
    } catch (err: any) {
      setTestResult('Connection check error: ' + err.message);
    } finally {
      setTesting(false);
    }
  };

  const copyMigrationSql = () => {
    const sql = `-- Run this in your Supabase SQL Editor:
-- ==============================================================================
-- GradeScan: Supabase PostgreSQL Schema Non-Destructive Update
-- ==============================================================================
ALTER TABLE IF EXISTS public.students ADD COLUMN IF NOT EXISTS lrn TEXT;
ALTER TABLE IF EXISTS public.exam_results ADD COLUMN IF NOT EXISTS raw_lrn TEXT;
CREATE INDEX IF NOT EXISTS idx_students_lrn ON public.students(lrn);
CREATE INDEX IF NOT EXISTS idx_exam_results_raw_lrn ON public.exam_results(raw_lrn);

CREATE OR REPLACE VIEW public.questions WITH (security_invoker = true) AS SELECT * FROM public.answer_keys;
CREATE OR REPLACE VIEW public.scan_results WITH (security_invoker = true) AS SELECT * FROM public.exam_results;
CREATE OR REPLACE VIEW public.student_answers WITH (security_invoker = true) AS SELECT * FROM public.exam_answers;
`;
    navigator.clipboard.writeText(sql);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Settings className="w-6 h-6 text-brand-700 dark:text-brand-400" />
          GradeScan Settings &amp; Supabase Integration
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Manage teacher profile, verify PostgreSQL database connectivity, and configure examination settings.
        </p>
      </div>

      {/* Teacher Profile Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="w-4 h-4 text-brand-700 dark:text-brand-400" />
            Instructor Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Full Name / Title
                </label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  School / Institution
                </label>
                <input
                  type="text"
                  required
                  value={schoolName}
                  onChange={(e) => setSchoolName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Account Email
              </label>
              <input
                type="text"
                disabled
                value={profile?.email || 'teacher@gradescan.edu'}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/50 text-slate-500 cursor-not-allowed"
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" isLoading={saving} leftIcon={<Save className="w-4 h-4" />}>
                Save Profile
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Security & Password Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-brand-700 dark:text-brand-400" />
            Security &amp; Account Password
          </CardTitle>
          <p className="text-xs text-slate-500">Update your account authentication credentials</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpdatePassword} className="space-y-4">
            {passwordSuccess && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                Password updated successfully!
              </div>
            )}
            {passwordError && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                {passwordError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  New Password (min 6 characters)
                </label>
                <div className="relative">
                  <input
                    type="password"
                    required
                    minLength={6}
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-brand-500 pl-9"
                  />
                  <Lock className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Confirm New Password
                </label>
                <div className="relative">
                  <input
                    type="password"
                    required
                    minLength={6}
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-brand-500 pl-9"
                  />
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                isLoading={passwordUpdating}
                leftIcon={<KeyRound className="w-4 h-4" />}
              >
                Change Password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Supabase Connection Architecture */}
      <Card>
        <CardHeader
          action={
            <Badge variant={isConfigured ? 'success' : 'teal'} size="md">
              {isConfigured ? 'Live Supabase Connected' : 'Cloud Setup Required'}
            </Badge>
          }
        >
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="w-4 h-4 text-brand-700 dark:text-brand-400" />
            Supabase Backend Integration
          </CardTitle>
          <p className="text-xs text-slate-500">PostgreSQL Relational Schema with Row-Level Security (RLS)</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            GradeScan is engineered to connect to your Supabase PostgreSQL database. When configured via <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px]">.env</code>, all classes, students, answer keys, and camera scans synchronize in real-time.
          </p>

          <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl space-y-2 text-xs">
            <div className="font-semibold text-slate-800 dark:text-slate-200">Required Environment Variables:</div>
            <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto">
{`VITE_SUPABASE_URL=https://gwlcjytuafdoflposdsn.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key`}
            </pre>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              isLoading={testing}
              onClick={handleTestSupabase}
              leftIcon={<ShieldCheck className="w-4 h-4 text-emerald-600" />}
            >
              Test Connection
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={copyMigrationSql}
              leftIcon={copiedSql ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
            >
              {copiedSql ? 'SQL Copied!' : 'Copy Migration SQL'}
            </Button>
          </div>

          {testResult && (
            <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-xs text-blue-900 dark:text-blue-300">
              {testResult}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
