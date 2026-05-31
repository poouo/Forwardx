import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarInitial, avatarSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  user?: {
    id?: number | string | null;
    username?: string | null;
    name?: string | null;
    avatar?: string | null;
  } | null;
  className?: string;
  imageClassName?: string;
};

export function UserAvatar({ user, className, imageClassName }: UserAvatarProps) {
  return (
    <Avatar className={cn("border", className)}>
      <AvatarImage
        src={avatarSrc(user?.avatar, user?.id || user?.username || user?.name)}
        alt={String(user?.username || user?.name || "User")}
        className={cn("object-cover", imageClassName)}
      />
      <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
        {avatarInitial(user)}
      </AvatarFallback>
    </Avatar>
  );
}
