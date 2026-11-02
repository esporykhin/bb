---
name: thread-kanban
description: Вести статусы тредов на канбан-доске. Используй при начале работы, блокировке, передаче на проверку и завершении задачи.
---
# Канбан тредов

Каждая карточка — существующий тред. Используй `$BB_THREAD_ID` или явный ID:

```sh
bb thread-kanban move "$BB_THREAD_ID" in_progress
bb thread-kanban move "$BB_THREAD_ID" blocked
bb thread-kanban move "$BB_THREAD_ID" review
bb thread-kanban move "$BB_THREAD_ID" done
bb thread-kanban list
```

Статусы: `backlog`, `in_progress`, `review`, `blocked`, `done`.
Начало хода автоматически выставляет in_progress (кроме done), ошибка — blocked,
конец хода — review, если карточка была in_progress. Выставляй blocked, когда
требуется внешний ответ; review, когда результат готов к приёмке; done — только
когда задача действительно завершена. Для возобновления done явно выставь
in_progress. idle само по себе не означает завершения задачи.
Команды возвращают JSON. list показывает только сохранённые статусы: треды
без записи отображаются в UI по состоянию выполнения или в бэклоге.
Не запускай и не отправляй сообщения другим тредам ради смены колонки.

## Задачи конкретным агентам

```sh
bb thread-kanban profiles
bb thread-kanban create <project-id> <agent-id> "Название" "Ожидаемый результат"
bb thread-kanban assign <thread-id> <agent-id>
```

create запускает обычный тред с полными инструкциями выбранного профиля;
assign меняет только ответственного на доске, не роль запущенной сессии.
Если профиль указан в метаданных текущего треда, прочитай
`kanban_role_context` при начале сессии и выполняй задачу в этой роли.
Модель и разрешения остаются настройками проекта BB.
