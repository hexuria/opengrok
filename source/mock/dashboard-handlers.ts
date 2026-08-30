import {
  GetMeResponse,
  GetTeamAdminSettingsResponse,
  GetTeamsResponse,
  GetUserPrivacyModeResponse,
  LocalToolControls,
  LocalToolPermissionCeiling,
  Team,
  type UpdateUserNameRequest,
  UpdateUserNameResponse,
} from "../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { PrivacyMode } from "../packages/proto/generated/aiserver/v1/privacy_mode_pb.js";
import { MOCK_JWT_EMAIL, MOCK_JWT_SUBJECT } from "./constants.js";

export interface MockProfile {
  email: string;
  firstName: string;
  lastName: string;
  sub: string;
}

export function createDefaultMockProfile(): MockProfile {
  return {
    email: MOCK_JWT_EMAIL,
    firstName: "Hexuria",
    lastName: "Mock",
    sub: MOCK_JWT_SUBJECT,
  };
}

export function createDashboardHandlers(profile: MockProfile): Record<string, (...args: never[]) => unknown> {
  return {
    getMe() {
      return new GetMeResponse({
        authId: profile.sub,
        userId: 1,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
      });
    },
    getTeams() {
      return new GetTeamsResponse({
        teams: [
          new Team({
            id: 42,
            name: "Mock Team",
            seats: 1,
            hasBilling: true,
            isEnterprise: false,
            teamSlug: "mock-team",
          }),
        ],
      });
    },
    getUserPrivacyMode() {
      return new GetUserPrivacyModeResponse({
        privacyMode: PrivacyMode.NO_TRAINING,
      });
    },
    getTeamAdminSettingsOrEmptyIfNotInTeam() {
      return new GetTeamAdminSettingsResponse({
        localToolControls: new LocalToolControls({
          permissionCeiling: LocalToolPermissionCeiling.ALWAYS,
        }),
      });
    },
    getTeamAdminSettings() {
      return new GetTeamAdminSettingsResponse({
        localToolControls: new LocalToolControls({
          permissionCeiling: LocalToolPermissionCeiling.ALWAYS,
        }),
      });
    },
    updateUserName(request: UpdateUserNameRequest) {
      profile.firstName = request.firstName;
      profile.lastName = request.lastName;
      return new UpdateUserNameResponse();
    },
  };
}
