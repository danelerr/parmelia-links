import { signInWithGoogle } from "../firebase";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import Logo from "../components/Logo";

export default function Login() {
  const navigate = useNavigate();

  async function handleLogin() {
    try {
      const credential = await signInWithGoogle();
      await credential.user.getIdToken(true);
      navigate("/");
    } catch (err) {
      sileo.error({ title: "Error al iniciar sesion" });
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-5 sm:px-8">
      <Logo className="w-24 sm:w-28 mb-6" />
      <h1 className="text-3xl sm:text-4xl mb-16">Parmelia</h1>

      <div className="w-full max-w-sm px-4">
        <button
          onClick={handleLogin}
          className="w-full bg-surface hover:bg-surface-2 text-white text-base py-4 rounded-xl transition-colors"
        >
          Ingresar
        </button>
      </div>
    </div>
  );
}
