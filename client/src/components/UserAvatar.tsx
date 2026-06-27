import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { GeneratedAvatar } from "@/components/GeneratedAvatar";
import { avatarInitial, avatarSeed, avatarSrc } from "@/lib/avatar";
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
  const fallback = user?.id || user?.username || user?.name;
  const src = avatarSrc(user?.avatar, fallback);
  return (
    <Avatar className={cn("border", className)}>
      {src ? (
        <>
          <AvatarImage
            src={src}
            alt={String(user?.username || user?.name || "User")}
            className={cn("object-cover", imageClassName)}
          />
          <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
            {avatarInitial(user)}
          </AvatarFallback>
        </>
      ) : (
        <GeneratedAvatar seed={avatarSeed(user?.avatar, fallback)} className={imageClassName} />
      )}
    </Avatar>
  );
}
