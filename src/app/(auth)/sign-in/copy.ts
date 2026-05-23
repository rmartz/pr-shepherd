export const SIGN_IN_COPY = {
  title: "Sign in",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  passwordLabel: "Password",
  submitButton: "Sign in",
  forgotPasswordLink: "Forgot password?",
  signUpPrompt: "Don't have an account?",
  signUpLink: "Sign up",
  errors: {
    "auth/invalid-credential": "Invalid email or password.",
    "auth/user-not-found": "Invalid email or password.",
    "auth/wrong-password": "Invalid email or password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    default: "Something went wrong. Please try again.",
  },
} as const;
