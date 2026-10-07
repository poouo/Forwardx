import * as telegram from "./repositories/userRepository";
import * as discord from "./discordAccounts";
import { isDiscordBotContext } from "./botTransportContext";

export const botAccounts = {
  async getUserById(id: string) {
    return isDiscordBotContext() ? discord.discordBotUser(await discord.getDiscordUser("discordId", id)) : telegram.getUserByTelegramId(id);
  },
  async getUserByBindCode(code: string) {
    return isDiscordBotContext() ? discord.discordBotUser(await discord.getDiscordUser("discordBindCode", code)) : telegram.getUserByTelegramBindCode(code);
  },
  updateLastSeen(id: string, identity: any) {
    return isDiscordBotContext() ? discord.updateDiscordLastSeen(id, identity) : telegram.updateTelegramLastSeen(id, identity);
  },
  createLoginCode(userId: number, code: string, expiresAt: Date) {
    return isDiscordBotContext() ? discord.createDiscordCode(userId, code, expiresAt, "Login") : telegram.createTelegramLoginCode(userId, code, expiresAt);
  },
  clearBindCode(userId: number) {
    return isDiscordBotContext() ? discord.clearDiscordBindCode(userId) : telegram.clearTelegramBindCode(userId);
  },
  bind(userId: number, identity: any, code: string) {
    return isDiscordBotContext() ? discord.bindDiscordAccount(userId, identity, code) : telegram.bindTelegramAccount(userId, identity);
  },
  unbind(userId: number) {
    return isDiscordBotContext() ? discord.unbindDiscordAccount(userId) : telegram.unbindTelegramAccount(userId);
  },
};
