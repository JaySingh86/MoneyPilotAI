// Thin routes for proposals (BACKEND_PLAN §8.2). Recipe: ../../lib/module.ts.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  CreateProposal,
  HouseholdParams,
  Proposal,
  ProposalList,
  ProposalListQuery,
  ProposalParams,
  RejectProposalBody,
} from "@mp/contracts";
import { actor } from "../items/actor";
import * as service from "./service";
import type { ProposalsDeps } from "./service";

export function proposalsRoutes(deps: () => ProposalsDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/proposals",
      {
        schema: {
          summary: "Proposals, newest first",
          params: HouseholdParams,
          querystring: ProposalListQuery,
          response: { 200: ProposalList },
        },
      },
      async (request) => service.listProposals(deps(), actor(request), request.query),
    );

    scope.post(
      "/households/:hid/proposals",
      {
        schema: {
          summary: "Ask the other member to approve a goal or shortfall change",
          params: HouseholdParams,
          body: CreateProposal,
          response: { 201: Proposal },
        },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const proposal = await service.createProposal(deps(), actor(request), request.body);
        return reply
          .code(201)
          .header("location", `/v1/households/${proposal.householdId}/proposals/${proposal.id}`)
          .send(proposal);
      },
    );

    scope.get(
      "/households/:hid/proposals/:id",
      { schema: { summary: "One proposal", params: ProposalParams, response: { 200: Proposal } } },
      async (request) => service.getProposal(deps(), actor(request), request.params.id),
    );

    scope.post(
      "/households/:hid/proposals/:id/approve",
      {
        schema: {
          summary: "Approve and apply a proposal (not your own)",
          params: ProposalParams,
          response: { 200: Proposal },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.approveProposal(deps(), actor(request), request.params.id),
    );

    scope.post(
      "/households/:hid/proposals/:id/reject",
      {
        schema: {
          summary: "Reject a proposal (not your own)",
          params: ProposalParams,
          body: RejectProposalBody.nullish(),
          response: { 200: Proposal },
        },
        config: { idempotency: "optional" },
      },
      async (request) =>
        service.rejectProposal(deps(), actor(request), request.params.id, request.body?.note),
    );
  };
}
