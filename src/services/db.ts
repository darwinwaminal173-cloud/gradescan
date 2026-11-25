// ==============================================================================
// GradeScan - Supabase Relational Database Service
// Permanent Cloud Database & Cross-Device Synchronization Engine
// ==============================================================================

import { supabase } from '@/lib/supabase';
import { 
  ClassRoom, 
  Student, 
  Quiz, 
  AnswerKey, 
  ExamResult, 
  ExamAnswer, 
  DashboardStats 
} from '@/types/database';

/**
 * Validates whether a given string is a standard RFC 4122 UUID.
 * Prevents PostgreSQL 'invalid input syntax for type uuid' errors.
 */
export function isValidUUID(id: string | null | undefined): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

/**
 * Retrieves the current authenticated educator's user ID from Supabase Auth.
 * Enforces that all database operations belong strictly to the authenticated account.
 */
export async function getAuthUserId(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.user?.id) {
    throw new Error('Authentication required. Please sign in to access GradeScan.');
  }
  return session.user.id;
}

export const db = {
  // ---------------------------------------------------------------------------
  // CLASSES
  // ---------------------------------------------------------------------------

  /**
   * Fetches all classes belonging to the authenticated teacher.
   * Joins class_students to calculate the live student count for each class.
   */
  async getClasses(overrideTeacherId?: string): Promise<ClassRoom[]> {
    const teacherId = overrideTeacherId || await getAuthUserId();
    const { data, error } = await supabase
      .from('classes')
      .select('*, class_students(id)')
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase getClasses error:', error.message);
      throw error;
    }

    if (!data) return [];

    return data.map((c: any) => ({
      id: c.id,
      teacher_id: c.teacher_id,
      name: c.name,
      section: c.section,
      subject: c.subject,
      academic_year: c.academic_year,
      description: c.description,
      created_at: c.created_at,
      updated_at: c.updated_at,
      student_count: Array.isArray(c.class_students) ? c.class_students.length : 0,
    }));
  },

  /**
   * Creates a new class room associated with the authenticated teacher.
   */
  async createClass(
    c: Omit<ClassRoom, 'id' | 'created_at' | 'updated_at' | 'teacher_id'> & { teacher_id?: string }
  ): Promise<ClassRoom> {
    const teacherId = c.teacher_id || await getAuthUserId();
    const classPayload = {
      name: c.name.trim(),
      section: c.section && c.section.trim() !== '' ? c.section.trim() : null,
      subject: c.subject && c.subject.trim() !== '' ? c.subject.trim() : null,
      academic_year: c.academic_year || '2025-2026',
      description: c.description && c.description.trim() !== '' ? c.description.trim() : null,
      teacher_id: teacherId,
    };

    const { data, error } = await supabase
      .from('classes')
      .insert([classPayload])
      .select()
      .single();

    if (error) {
      console.error('Supabase createClass error:', error.message);
      throw error;
    }

    return {
      ...data,
      student_count: 0,
    };
  },

  /**
   * Updates an existing class.
   */
  async updateClass(id: string, updates: Partial<ClassRoom>): Promise<ClassRoom> {
    const teacherId = await getAuthUserId();
    const cleanUpdates = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    // Do not attempt to update computed student_count
    delete (cleanUpdates as any).student_count;

    const { data, error } = await supabase
      .from('classes')
      .update(cleanUpdates)
      .eq('id', id)
      .eq('teacher_id', teacherId)
      .select()
      .single();

    if (error) {
      console.error('Supabase updateClass error:', error.message);
      throw error;
    }

    return data;
  },

  /**
   * Deletes a class by ID. Automatically un-enrolls students via database foreign key cascade.
   */
  async deleteClass(id: string): Promise<void> {
    const teacherId = await getAuthUserId();
    const { error } = await supabase
      .from('classes')
      .delete()
      .eq('id', id)
      .eq('teacher_id', teacherId);

    if (error) {
      console.error('Supabase deleteClass error:', error.message);
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // STUDENTS & ROSTERS
  // ---------------------------------------------------------------------------

  /**
   * Fetches students for the authenticated teacher.
   * If classId is specified, filters by class membership.
   * Joins class_students to populate the assigned classes for each student.
   */
  async getStudents(overrideTeacherId?: string, classId?: string): Promise<Student[]> {
    const teacherId = overrideTeacherId || await getAuthUserId();

    let query = supabase
      .from('students')
      .select('*, class_students(class:classes(*))')
      .eq('teacher_id', teacherId);

    if (classId && classId !== 'all') {
      const { data: junction, error: jErr } = await supabase
        .from('class_students')
        .select('student_id')
        .eq('class_id', classId);

      if (jErr) {
        console.error('Supabase class enrollment query error:', jErr.message);
        throw jErr;
      }

      const enrolledStudentIds = junction?.map((j: any) => j.student_id) || [];
      if (enrolledStudentIds.length === 0) {
        return [];
      }
      query = query.in('id', enrolledStudentIds);
    }

    const { data, error } = await query.order('last_name', { ascending: true });

    if (error) {
      console.error('Supabase getStudents error:', error.message);
      throw error;
    }

    if (!data) return [];

    return data.map((s: any) => {
      const studentClasses: ClassRoom[] = (s.class_students || [])
        .map((cs: any) => cs.class)
        .filter(Boolean);
      return {
        id: s.id,
        teacher_id: s.teacher_id,
        student_number: s.student_number,
        lrn: s.lrn || null,
        first_name: s.first_name,
        last_name: s.last_name,
        email: s.email || null,
        grade_level: s.grade_level || null,
        notes: s.notes || null,
        created_at: s.created_at,
        updated_at: s.updated_at,
        classes: studentClasses,
      };
    });
  },

  /**
   * Creates a student record in Supabase and optionally enrolls them in a class.
   */
  async createStudent(
    s: Omit<Student, 'id' | 'created_at' | 'updated_at' | 'teacher_id'> & { teacher_id?: string }, 
    classId?: string
  ): Promise<Student> {
    const teacherId = s.teacher_id || await getAuthUserId();
    const validClassId = classId && isValidUUID(classId) ? classId.trim() : undefined;

    const studentPayload: any = {
      teacher_id: teacherId,
      student_number: s.student_number.trim(),
      first_name: s.first_name.trim(),
      last_name: s.last_name.trim(),
      email: s.email && s.email.trim() !== '' ? s.email.trim() : null,
      grade_level: s.grade_level || null,
      notes: s.notes || null,
    };

    if (s.lrn && s.lrn.trim() !== '') {
      studentPayload.lrn = s.lrn.trim();
    }

    const { data, error } = await supabase
      .from('students')
      .insert([studentPayload])
      .select()
      .single();

    if (error) {
      console.error('Supabase createStudent error:', error.message);
      throw error;
    }

    // Enroll in selected class if specified
    if (validClassId && data?.id) {
      const { error: enrollErr } = await supabase
        .from('class_students')
        .insert([{ class_id: validClassId, student_id: data.id }]);
      if (enrollErr) {
        console.warn('Initial student class enrollment note:', enrollErr.message);
      }
    }

    return data;
  },

  /**
   * Creates multiple students in batch.
   */
  async bulkCreateStudents(
    studentsList: Array<Omit<Student, 'id' | 'created_at' | 'updated_at'>>, 
    classId?: string
  ): Promise<number> {
    let createdCount = 0;
    for (const item of studentsList) {
      await this.createStudent(item, classId);
      createdCount++;
    }
    return createdCount;
  },

  /**
   * Updates an existing student record.
   */
  async updateStudent(id: string, updates: Partial<Student>): Promise<Student> {
    const teacherId = await getAuthUserId();
    const cleanUpdates = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    // Do not attempt to update joined classes array directly on the student row
    delete (cleanUpdates as any).classes;

    const { data, error } = await supabase
      .from('students')
      .update(cleanUpdates)
      .eq('id', id)
      .eq('teacher_id', teacherId)
      .select()
      .single();

    if (error) {
      console.error('Supabase updateStudent error:', error.message);
      throw error;
    }

    return data;
  },

  /**
   * Deletes a student by ID.
   */
  async deleteStudent(id: string): Promise<void> {
    const teacherId = await getAuthUserId();
    const { error } = await supabase
      .from('students')
      .delete()
      .eq('id', id)
      .eq('teacher_id', teacherId);

    if (error) {
      console.error('Supabase deleteStudent error:', error.message);
      throw error;
    }
  },

  /**
   * Enrolls a student into a class room.
   */
  async enrollStudent(classId: string, studentId: string): Promise<void> {
    if (!isValidUUID(classId) || !isValidUUID(studentId)) {
      throw new Error('Valid UUIDs required for class enrollment.');
    }

    const { error } = await supabase
      .from('class_students')
      .upsert(
        [{ class_id: classId, student_id: studentId }], 
        { onConflict: 'class_id,student_id' }
      );

    if (error) {
      console.error('Supabase enrollStudent error:', error.message);
      throw error;
    }
  },

  /**
   * Removes a student enrollment from a class room.
   */
  async unenrollStudent(classId: string, studentId: string): Promise<void> {
    const { error } = await supabase
      .from('class_students')
      .delete()
      .match({ class_id: classId, student_id: studentId });

    if (error) {
      console.error('Supabase unenrollStudent error:', error.message);
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // QUIZZES & EXAMINATIONS
  // ---------------------------------------------------------------------------

  /**
   * Fetches all quizzes belonging to the authenticated teacher.
   * Computes dynamic results count and average score from exam_results.
   */
  async getQuizzes(overrideTeacherId?: string): Promise<Quiz[]> {
    const teacherId = overrideTeacherId || await getAuthUserId();
    const { data, error } = await supabase
      .from('quizzes')
      .select(`
        *,
        classes ( id, name ),
        exam_results ( id, percentage )
      `)
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase getQuizzes error:', error.message);
      throw error;
    }

    if (!data) return [];

    return data.map((q: any) => {
      const results = Array.isArray(q.exam_results) ? q.exam_results : [];
      const avg = results.length > 0
        ? results.reduce((acc: number, cur: any) => acc + (cur.percentage || 0), 0) / results.length
        : 0;

      return {
        id: q.id,
        teacher_id: q.teacher_id,
        class_id: q.class_id,
        title: q.title,
        description: q.description,
        exam_date: q.exam_date,
        total_questions: q.total_questions,
        options_per_question: q.options_per_question,
        default_points_per_question: Number(q.default_points_per_question),
        passing_percentage: Number(q.passing_percentage),
        sheet_template: q.sheet_template,
        created_at: q.created_at,
        updated_at: q.updated_at,
        class_name: q.classes?.name,
        results_count: results.length,
        average_score: Math.round(avg * 10) / 10,
      };
    });
  },

  /**
   * Fetches a single quiz by ID.
   */
  async getQuizById(id: string): Promise<Quiz | null> {
    if (!isValidUUID(id)) return null;

    const { data, error } = await supabase
      .from('quizzes')
      .select('*, classes ( id, name )')
      .eq('id', id)
      .single();

    if (error) {
      console.warn('Supabase getQuizById note:', error.message);
      return null;
    }

    if (!data) return null;

    return {
      ...data,
      class_name: data.classes?.name,
    };
  },

  /**
   * Creates a new quiz and automatically seeds answer keys in Supabase.
   */
  async createQuiz(
    quizData: Omit<Quiz, 'id' | 'created_at' | 'updated_at' | 'teacher_id'> & { teacher_id?: string }, 
    answerKeys?: Partial<AnswerKey>[]
  ): Promise<Quiz> {
    const teacherId = quizData.teacher_id || await getAuthUserId();
    const cleanClassId = quizData.class_id && isValidUUID(quizData.class_id) ? quizData.class_id : null;

    const payload = {
      ...quizData,
      class_id: cleanClassId,
      teacher_id: teacherId,
    };

    const { data: newQuiz, error } = await supabase
      .from('quizzes')
      .insert([payload])
      .select()
      .single();

    if (error || !newQuiz) {
      console.error('Supabase createQuiz error:', error?.message);
      throw error;
    }

    // Automatically seed answer keys for questions 1..total_questions in Supabase
    const keysToInsert: any[] = [];
    for (let q = 1; q <= newQuiz.total_questions; q++) {
      const existingKey = answerKeys?.find(k => k.question_number === q);
      keysToInsert.push({
        quiz_id: newQuiz.id,
        question_number: q,
        correct_options: existingKey?.correct_options || ['A'],
        points: existingKey?.points || newQuiz.default_points_per_question,
        is_bonus: existingKey?.is_bonus || false,
        is_excluded: existingKey?.is_excluded || false,
        explanation: existingKey?.explanation || null,
      });
    }

    if (keysToInsert.length > 0) {
      const { error: keysErr } = await supabase
        .from('answer_keys')
        .insert(keysToInsert);
      if (keysErr) {
        console.warn('Initial answer keys insertion note:', keysErr.message);
      }
    }

    return {
      ...newQuiz,
      results_count: 0,
      average_score: 0,
    };
  },

  /**
   * Updates quiz metadata.
   */
  async updateQuiz(id: string, updates: Partial<Quiz>): Promise<Quiz> {
    const teacherId = await getAuthUserId();
    const cleanUpdates = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    delete (cleanUpdates as any).class_name;
    delete (cleanUpdates as any).results_count;
    delete (cleanUpdates as any).average_score;
    delete (cleanUpdates as any).answer_keys;

    const { data, error } = await supabase
      .from('quizzes')
      .update(cleanUpdates)
      .eq('id', id)
      .eq('teacher_id', teacherId)
      .select()
      .single();

    if (error) {
      console.error('Supabase updateQuiz error:', error.message);
      throw error;
    }

    return data;
  },

  /**
   * Deletes a quiz and all associated answer keys and exam results (cascaded).
   */
  async deleteQuiz(id: string): Promise<void> {
    const teacherId = await getAuthUserId();
    const { error } = await supabase
      .from('quizzes')
      .delete()
      .eq('id', id)
      .eq('teacher_id', teacherId);

    if (error) {
      console.error('Supabase deleteQuiz error:', error.message);
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // ANSWER KEYS
  // ---------------------------------------------------------------------------

  /**
   * Fetches answer keys for a specific quiz.
   */
  async getAnswerKeys(quizId: string): Promise<AnswerKey[]> {
    if (!isValidUUID(quizId)) return [];

    const { data, error } = await supabase
      .from('answer_keys')
      .select('*')
      .eq('quiz_id', quizId)
      .order('question_number', { ascending: true });

    if (error) {
      console.error('Supabase getAnswerKeys error:', error.message);
      throw error;
    }

    return data || [];
  },

  /**
   * Persists or updates answer keys for a quiz.
   */
  async saveAnswerKeys(quizId: string, keys: AnswerKey[]): Promise<void> {
    if (!isValidUUID(quizId)) throw new Error('Invalid quiz UUID');

    const cleanKeys = keys.map(k => ({
      quiz_id: quizId,
      question_number: k.question_number,
      correct_options: k.correct_options,
      points: k.points,
      is_bonus: k.is_bonus,
      is_excluded: k.is_excluded,
      explanation: k.explanation || null,
    }));

    const { error } = await supabase
      .from('answer_keys')
      .upsert(cleanKeys, { onConflict: 'quiz_id,question_number' });

    if (error) {
      console.error('Supabase saveAnswerKeys error:', error.message);
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // EXAM RESULTS & SCANNED SHEETS
  // ---------------------------------------------------------------------------

  /**
   * Fetches exam results with joined student, quiz, and answers data.
   */
  async getExamResults(filters?: { quizId?: string; studentId?: string; teacherId?: string }): Promise<ExamResult[]> {
    const teacherId = filters?.teacherId || await getAuthUserId();

    let query = supabase
      .from('exam_results')
      .select(`
        *,
        students ( * ),
        quizzes ( title, passing_percentage, total_questions ),
        exam_answers ( * )
      `)
      .eq('teacher_id', teacherId)
      .order('scanned_at', { ascending: false });

    if (filters?.quizId && isValidUUID(filters.quizId)) {
      query = query.eq('quiz_id', filters.quizId);
    }
    if (filters?.studentId && isValidUUID(filters.studentId)) {
      query = query.eq('student_id', filters.studentId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Supabase getExamResults error:', error.message);
      throw error;
    }

    if (!data) return [];

    return data.map((r: any) => ({
      id: r.id,
      quiz_id: r.quiz_id,
      student_id: r.student_id,
      teacher_id: r.teacher_id,
      raw_student_number: r.raw_student_number,
      raw_lrn: r.raw_lrn,
      scanned_image_url: r.scanned_image_url,
      total_score: Number(r.total_score),
      max_score: Number(r.max_score),
      percentage: Number(r.percentage),
      correct_count: Number(r.correct_count),
      incorrect_count: Number(r.incorrect_count),
      unanswered_count: Number(r.unanswered_count),
      passed: Boolean(r.passed),
      scan_confidence: Number(r.scan_confidence),
      needs_review: Boolean(r.needs_review),
      scanned_at: r.scanned_at,
      updated_at: r.updated_at,
      student: r.students,
      quiz: r.quizzes,
      answers: Array.isArray(r.exam_answers)
        ? [...r.exam_answers].sort((a: any, b: any) => a.question_number - b.question_number)
        : [],
    }));
  },

  /**
   * Fetches itemized answers for a specific exam result.
   */
  async getExamAnswers(resultId: string): Promise<ExamAnswer[]> {
    if (!isValidUUID(resultId)) return [];

    const { data, error } = await supabase
      .from('exam_answers')
      .select('*')
      .eq('result_id', resultId)
      .order('question_number', { ascending: true });

    if (error) {
      console.error('Supabase getExamAnswers error:', error.message);
      throw error;
    }

    return data || [];
  },

  /**
   * Persists a scanned exam result and its individual question answers to Supabase.
   */
  async saveExamResult(
    result: Omit<ExamResult, 'id' | 'scanned_at' | 'updated_at'>, 
    answers: Omit<ExamAnswer, 'id' | 'result_id'>[]
  ): Promise<ExamResult> {
    const teacherId = await getAuthUserId();
    const cleanStudentId = result.student_id && isValidUUID(result.student_id) ? result.student_id : null;

    const payload: any = {
      quiz_id: result.quiz_id,
      student_id: cleanStudentId,
      teacher_id: teacherId,
      raw_student_number: result.raw_student_number || null,
      scanned_image_url: result.scanned_image_url || null,
      total_score: result.total_score,
      max_score: result.max_score,
      percentage: result.percentage,
      correct_count: result.correct_count,
      incorrect_count: result.incorrect_count,
      unanswered_count: result.unanswered_count,
      passed: result.passed,
      scan_confidence: result.scan_confidence || 100,
      needs_review: result.needs_review || false,
    };

    if (result.raw_lrn && result.raw_lrn.trim() !== '') {
      payload.raw_lrn = result.raw_lrn.trim();
    }

    const { data: insertedResult, error: resErr } = await supabase
      .from('exam_results')
      .insert([payload])
      .select()
      .single();

    if (resErr || !insertedResult) {
      console.error('Supabase saveExamResult error:', resErr?.message);
      throw resErr || new Error('Failed to insert exam result');
    }

    // Insert associated question answer bubbles
    if (answers && answers.length > 0) {
      const answersToInsert = answers.map(a => {
        const { id, result_id, ...cleanAns } = (a as any);
        return {
          ...cleanAns,
          result_id: insertedResult.id,
        };
      });

      const { error: ansErr } = await supabase
        .from('exam_answers')
        .insert(answersToInsert);

      if (ansErr) {
        console.error('Supabase exam_answers insert error:', ansErr.message);
      }
    }

    // Dispatch global event for reactive UI updates
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gradescan:result_saved', { detail: { resultId: insertedResult.id } }));
    }

    return insertedResult;
  },

  /**
   * Deletes an exam result. Associated exam_answers are deleted via database cascade.
   */
  async deleteExamResult(id: string): Promise<void> {
    const teacherId = await getAuthUserId();
    const { error } = await supabase
      .from('exam_results')
      .delete()
      .eq('id', id)
      .eq('teacher_id', teacherId);

    if (error) {
      console.error('Supabase deleteExamResult error:', error.message);
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // DASHBOARD AGGREGATE STATS
  // ---------------------------------------------------------------------------

  /**
   * Calculates overall dashboard statistics from Supabase for the authenticated teacher.
   */
  async getDashboardStats(overrideTeacherId?: string): Promise<DashboardStats> {
    const teacherId = overrideTeacherId || await getAuthUserId();
    const [students, classes, quizzes, results] = await Promise.all([
      this.getStudents(teacherId),
      this.getClasses(teacherId),
      this.getQuizzes(teacherId),
      this.getExamResults({ teacherId }),
    ]);

    const totalScans = results.length;
    const scores = results.map(r => r.percentage);
    const averageScore = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : 0;
    const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
    const lowestScore = scores.length > 0 ? Math.min(...scores) : 0;
    const passingCount = results.filter(r => r.passed).length;
    const passingRate = totalScans > 0 ? Math.round((passingCount / totalScans) * 100) : 0;

    return {
      totalStudents: students.length,
      totalClasses: classes.length,
      totalQuizzes: quizzes.length,
      totalScans,
      averageScore,
      highestScore,
      lowestScore,
      passingRate,
    };
  }
};
