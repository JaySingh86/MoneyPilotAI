// Thin routes for notifications (BACKEND_PLAN §8.2). Recipe: ../../lib/module.ts.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  HouseholdParams,
  ItemReminderParams,
  ItemReminderRule,
  Notification,
  NotificationList,
  NotificationListQuery,
  NotificationParams,
  NotificationPreferences,
  ReminderRule,
  UpdateNotificationPreferences,
} from "@mp/contracts";
import { dbContext, requireUserId } from "../../plugins/request-context";
import { actor } from "../items/actor";
import * as service from "./service";
import type { NotifyDeps } from "./service";

export function notifyRoutes(deps: () => NotifyDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/notifications",
      {
        schema: {
          summary: "The caller's notifications, newest first, with the unread count",
          params: HouseholdParams,
          querystring: NotificationListQuery,
          response: { 200: NotificationList },
        },
      },
      async (request) => service.listNotifications(deps(), actor(request), request.query),
    );

    scope.post(
      "/households/:hid/notifications/:id/read",
      {
        schema: {
          summary: "Mark one of the caller's notifications read",
          params: NotificationParams,
          response: { 200: Notification },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.markRead(deps(), actor(request), request.params.id),
    );

    scope.get(
      "/me/notification-preferences",
      {
        schema: {
          summary: "The caller's email notification preferences",
          response: { 200: NotificationPreferences },
        },
      },
      async (request) => service.getPreferences(deps(), dbContext(request), requireUserId(request)),
    );

    scope.put(
      "/me/notification-preferences",
      {
        schema: {
          summary: "Change the caller's email notification preferences",
          body: UpdateNotificationPreferences,
          response: { 200: NotificationPreferences },
        },
        config: { idempotency: "optional" },
      },
      async (request) =>
        service.updatePreferences(deps(), dbContext(request), requireUserId(request), request.body),
    );

    scope.get(
      "/households/:hid/reminder-rules",
      {
        schema: {
          summary: "The household's default reminder rule (built-in default until one is set)",
          params: HouseholdParams,
          response: { 200: ReminderRule },
        },
      },
      async (request) => service.getDefaultRule(deps(), actor(request)),
    );

    scope.put(
      "/households/:hid/reminder-rules",
      {
        schema: {
          summary: "Set the household's default reminder rule",
          params: HouseholdParams,
          body: ReminderRule,
          response: { 200: ReminderRule },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.putDefaultRule(deps(), actor(request), request.body),
    );

    scope.get(
      "/households/:hid/items/:id/reminders",
      {
        schema: {
          summary: "One item's own reminder rule, or null when it follows the household default",
          params: ItemReminderParams,
          response: { 200: ItemReminderRule },
        },
      },
      async (request) => service.getItemRule(deps(), actor(request), request.params.id),
    );

    scope.put(
      "/households/:hid/items/:id/reminders",
      {
        schema: {
          summary: "Set one item's reminder rule; a null body removes the override",
          params: ItemReminderParams,
          body: ItemReminderRule,
          response: { 200: ItemReminderRule },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.putItemRule(deps(), actor(request), request.params.id, request.body),
    );
  };
}
