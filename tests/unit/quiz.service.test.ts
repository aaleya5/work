import { QuizService } from '../../src/services/quiz.service';
import prisma from '../../src/prisma';
import { AppError } from '../../src/errors/app-error';
import type { AnswerDto } from '../../src/schemas/quiz.schema';

// ---------------------------------------------------------------------------
// Mock the Prisma singleton so no real database connection is required.
// ---------------------------------------------------------------------------
jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    quiz: { findUnique: jest.fn() },
    quizAttempt: { findMany: jest.fn(), create: jest.fn() },
  },
}));

type MockedPrisma = {
  quiz: { findUnique: jest.Mock };
  quizAttempt: { findMany: jest.Mock; create: jest.Mock };
};

const mockedPrisma = prisma as unknown as MockedPrisma;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

interface FakeQuestion {
  id: string;
  text: string;
  options: FakeOption[];
}

interface FakeQuiz {
  id: string;
  title: string;
  courseId: string;
  moduleId: string | null;
  maxAttempts: number;
  passScore: number;
  questions: FakeQuestion[];
}

/** A quiz with 5 questions, each having one correct option (`*-correct`). */
function buildFiveQuestionQuiz(overrides: Partial<FakeQuiz> = {}): FakeQuiz {
  const questions: FakeQuestion[] = Array.from({ length: 5 }, (_, i) => ({
    id: `q${i + 1}`,
    text: `Question ${i + 1}`,
    options: [
      { id: `q${i + 1}-correct`, text: 'Correct answer', isCorrect: true },
      { id: `q${i + 1}-wrong`, text: 'Wrong answer', isCorrect: false },
    ],
  }));

  return {
    id: 'quiz-1',
    title: 'Sample Quiz',
    courseId: 'course-1',
    moduleId: null,
    maxAttempts: 3,
    passScore: 70,
    questions,
    ...overrides,
  };
}

function answersForQuiz(quiz: FakeQuiz, correctCount: number): AnswerDto[] {
  return quiz.questions.map((question, index) => {
    const option = index < correctCount ? question.options[0] : question.options[1];
    return { questionId: question.id, selectedOptionId: option.id };
  });
}

describe('QuizService.submitAttempt', () => {
  let service: QuizService;

  beforeEach(() => {
    service = new QuizService();
    jest.clearAllMocks();
  });

  it('(a) returns a PASSED status when the score meets the pass threshold', async () => {
    const quiz = buildFiveQuestionQuiz({ passScore: 60 });
    mockedPrisma.quiz.findUnique.mockResolvedValue(quiz);
    mockedPrisma.quizAttempt.findMany.mockResolvedValue([]);
    mockedPrisma.quizAttempt.create.mockResolvedValue({});

    // 4 of 5 correct = 80% >= 60% pass score
    const result = await service.submitAttempt('user-1', quiz.id, answersForQuiz(quiz, 4));

    expect(result.status).toBe('PASSED');
    expect(result.score).toBe(80);
    expect(result.correctCount).toBe(4);
    expect(result.totalCount).toBe(5);
    expect(mockedPrisma.quizAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', quizId: quiz.id, status: 'PASSED' }),
      }),
    );
  });

  it('(b) throws a 409 AppError when the quiz has already been passed', async () => {
    const quiz = buildFiveQuestionQuiz();
    mockedPrisma.quiz.findUnique.mockResolvedValue(quiz);
    mockedPrisma.quizAttempt.findMany.mockResolvedValue([{ status: 'PASSED' }]);

    const error: unknown = await service
      .submitAttempt('user-1', quiz.id, answersForQuiz(quiz, 5))
      .catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).message).toBe('Quiz already passed');
    expect(mockedPrisma.quizAttempt.create).not.toHaveBeenCalled();
  });

  it('(c) throws a 422 AppError when max attempts have been exceeded', async () => {
    const quiz = buildFiveQuestionQuiz({ maxAttempts: 3 });
    mockedPrisma.quiz.findUnique.mockResolvedValue(quiz);
    mockedPrisma.quizAttempt.findMany.mockResolvedValue([
      { status: 'FAILED' },
      { status: 'FAILED' },
      { status: 'FAILED' },
    ]);

    const error: unknown = await service
      .submitAttempt('user-1', quiz.id, answersForQuiz(quiz, 1))
      .catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(422);
    expect((error as AppError).message).toBe('Max attempts exceeded');
    expect(mockedPrisma.quizAttempt.create).not.toHaveBeenCalled();
  });

  it('(d) scores 3 of 5 correct answers as 60%', async () => {
    const quiz = buildFiveQuestionQuiz({ passScore: 70 });
    mockedPrisma.quiz.findUnique.mockResolvedValue(quiz);
    mockedPrisma.quizAttempt.findMany.mockResolvedValue([]);
    mockedPrisma.quizAttempt.create.mockResolvedValue({});

    const result = await service.submitAttempt('user-1', quiz.id, answersForQuiz(quiz, 3));

    expect(result.score).toBe(60);
    expect(result.correctCount).toBe(3);
    expect(result.totalCount).toBe(5);
    expect(result.status).toBe('FAILED'); // 60 < passScore (70)
  });
});
