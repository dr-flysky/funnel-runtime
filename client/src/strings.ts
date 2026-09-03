/**
 * Текст интерфейса приложения: навигация, кнопки, заголовки таблиц, дашборд.
 *
 * Здесь НЕТ текстов самой воронки — заголовки шагов, подписи опций, сообщения
 * валидации, тексты результатов и CTA приходят из опубликованного конфига.
 * Перевести воронку — значит опубликовать переведённый конфиг, а не править этот файл.
 */
export const t = {
  nav: {
    funnel: 'Воронка',
    versions: 'Версии',
    analytics: 'Аналитика',
  },

  common: {
    loading: 'Загрузка…',
    back: 'Назад',
    continue: 'Продолжить',
    dismiss: 'Скрыть',
    version: (n: number | string) => `v${n}`,
  },

  boot: {
    nothingTitle: 'Пока нечего показать',
    noFunnelPublished: 'Ни одна воронка ещё не опубликована.',
    publishHint: 'Опубликуйте конфиг командой',
    thenReload: ', затем обновите страницу.',
  },

  funnel: {
    errorTitle: 'Что-то пошло не так',
    errorHint: 'Если воронка ещё не опубликована, выполните',
    variantPill: (v: string) => `Вариант ${v}`,
    forced: 'принудительно',
    progress: (position: number, total: number) => `Вопрос ${position} из ${total}`,
    footnote:
      'Ответы сохраняются на сервере — обновите страницу или закройте вкладку, и вы продолжите с того же места.',
    /** Запасной вариант, если конфиг шага не задал `primaryActionLabel`. */
    continueFallback: 'Продолжить',
    helpShow: 'Что это значит?',
    helpHide: 'Скрыть пояснение',
    multiSelectHint: (max: number, selected: number) =>
      `Выберите не более ${max}. Выбрано: ${selected}.`,
  },

  expiry: {
    onBoot: 'Прошлая сессия истекла, поэтому начинаем заново.',
    midSession: 'Сессия истекла, пока вкладка была открыта — начали новую.',
  },

  result: {
    badge: 'Ваша рекомендация',
    whatNext: 'Что делать дальше',
    restart: 'Пройти заново',
    /** Запасной вариант, если конфиг экрана результата их не задал. */
    failedTitle: 'Не удалось собрать рекомендацию',
    retry: 'Попробовать снова',
  },

  admin: {
    title: 'Управление версиями',
    funnelLabel: 'Воронка',
    activeVersion: 'активная версия',
    publishHeading: 'Публикация из репозитория',
    publishNote:
      'Публикация добавляет новую неизменяемую версию и направляет на неё новый трафик. Сессии, уже идущие по воронке, продолжают работать на своей версии — без передеплоя и без миграций.',
    noConfigFiles: 'Для этой воронки нет файлов конфигурации.',
    steps: 'шагов',
    declaresVersion: (n: number) => `объявляет v${n}`,
    publish: 'Опубликовать',
    published: (file: string) => `Опубликовано: ${file}`,
    versionsHeading: 'Версии',
    rollback: 'Откатить',
    rolledBack: 'Откат на предыдущую версию выполнен',
    activate: 'Активировать',
    activated: (v: number) => `Активирована v${v}`,
    active: 'активна',
    historyHeading: 'История активаций',
    columns: {
      version: 'Версия',
      steps: 'Шаги',
      results: 'Результаты',
      variants: 'Варианты',
      experiment: 'Эксперимент',
      publishedAt: 'Опубликована',
      note: 'Примечание',
    },
  },

  dashboard: {
    title: 'Аналитика воронки',
    subtitle: 'уникальным сессиям',
    subtitlePrefix: 'Все показатели считаются по',
    subtitleSuffix: ', а не по количеству событий.',
    filters: {
      campaign: 'Кампания',
      allCampaigns: 'Все кампании',
      version: 'Версия',
      allVersions: 'Все версии',
      includeSynthetic: 'Включая сгенерированный трафик',
    },
    kpi: {
      started: 'Начали',
      uniqueSessions: 'уникальных сессий',
      reachedResult: 'Дошли до результата',
      ctaClicks: 'Клики по CTA',
      ofResults: 'от дошедших до результата',
      ctaClickRate: 'Конверсия в клик по CTA',
      primaryMetric: 'основная метрика',
    },
    experiment: {
      heading: 'Эксперимент',
      description:
        'Вариант B меняет порядок вопросов и формулировки на экране результата. Назначение происходит на бэкенде и закреплено за сессией.',
      primaryMetricLabel: 'Основная метрика:',
      primaryMetricBody: (a: string, b: string) =>
        `cta_click_rate — уникальные сессии с ${a}, делённые на уникальные сессии с ${b}.`,
      ctaFrom: (cta: number, started: number) => `${cta} кликов по CTA из ${started} сессий`,
      reachedResult: 'Дошли до результата:',
      liftUp: 'выше',
      liftDown: 'ниже',
      lift: (dir: string, pct: string) => `Вариант B ${dir} A на ${pct} по основной метрике.`,
      liftCaveat:
        'Только направление — выборка недостаточна для статистической значимости.',
    },
    steps: {
      heading: 'По шагам',
      note: 'Конверсия считается как step_completed / step_viewed по каждому шагу, поэтому она остаётся корректной, когда пользователи идут по разным веткам. Отвал — это разница между ними.',
      columns: {
        step: 'Шаг',
        reached: 'Дошли',
        completed: 'Завершили',
        dropOff: 'Отвал',
        conversion: 'Конверсия',
        ofAllStarts: 'От всех начавших',
        backs: 'Возвраты',
        viewsPerSession: 'Просмотров на сессию',
        funnel: 'Воронка',
      },
    },
    results: {
      heading: 'Достигнутые рекомендации',
      note: 'На какой результат пришла каждая сессия — по правилам resultRules в порядке из конфига, с defaultResultId как запасным вариантом.',
      columns: {
        result: 'Результат',
        sessions: 'Сессии',
        share: 'Доля',
        ctaClicks: 'Клики по CTA',
        ctaRate: 'Конверсия в CTA',
      },
    },
    versions: {
      heading: 'Сравнение версий',
      columns: {
        version: 'Версия',
        sessions: 'Сессии',
        reachedResult: 'Дошли до результата',
        resultRate: 'Доля дошедших',
        ctaClickRate: 'Конверсия в клик по CTA',
      },
    },
    customEvents: {
      heading: 'События вне базового набора',
      note: 'Добавлены версией конфига, сохраняются и попадают в отчёт без изменения схемы базы.',
      columns: { event: 'Событие', events: 'События', sessions: 'Сессии' },
    },
    quality: {
      heading: 'Качество данных',
      note: 'Подтверждение того, что «грязные» случаи действительно произошли и были обработаны, а не просто отсутствовали.',
      scopedHeading: 'Текущая выборка',
      allTimeHeading: 'Весь приём событий, все воронки',
      allTimeNote:
        'Эти два показателя не сужаются фильтрами выше: подавленный дубль и отклонённое событие так и не стали строками, поэтому их не к чему отнести — ни к кампании, ни к версии.',
      labels: {
        totalEvents: 'всего событий',
        distinctSessions: 'уникальных сессий',
        outOfOrderEvents: 'пришло не по порядку',
        repeatStepViews: 'повторных просмотров шага',
        duplicatesSuppressed: 'дублей подавлено',
        rejectedEvents: 'событий отклонено',
      } as Record<string, string>,
    },
  },
} as const;
