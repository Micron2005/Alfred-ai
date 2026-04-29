import { AuthProvider } from "@/lib/AuthContext";
import { LoginGate } from "@/components/LoginGate";
import { ChatWindow } from "@/components/ChatWindow";

export default function HomePage() {
  return (
    <AuthProvider>
      <LoginGate>
        <ChatWindow />
      </LoginGate>
    </AuthProvider>
  );
}
