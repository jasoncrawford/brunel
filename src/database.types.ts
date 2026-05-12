export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      foreman_messages: {
        Row: {
          created_at: string
          direction: string
          id: number
          msg_type: string
          payload: Json
          repo_id: number | null
          task_id: string | null
          worker_id: string | null
        }
        Insert: {
          created_at?: string
          direction: string
          id?: never
          msg_type: string
          payload: Json
          repo_id?: number | null
          task_id?: string | null
          worker_id?: string | null
        }
        Update: {
          created_at?: string
          direction?: string
          id?: never
          msg_type?: string
          payload?: Json
          repo_id?: number | null
          task_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "foreman_messages_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      installations: {
        Row: {
          account_login: string
          account_type: string
          created_at: string
          github_id: number
          id: number
        }
        Insert: {
          account_login: string
          account_type: string
          created_at?: string
          github_id: number
          id?: number
        }
        Update: {
          account_login?: string
          account_type?: string
          created_at?: string
          github_id?: number
          id?: number
        }
        Relationships: []
      }
      repos: {
        Row: {
          created_at: string
          full_name: string
          id: number
          installation_id: number | null
          status: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id?: never
          installation_id?: number | null
          status?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: never
          installation_id?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "repos_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "installations"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_at: string | null
          body: string
          branch: string | null
          completed_at: string | null
          cost_usd: number | null
          created_at: string
          input_tokens: number | null
          issue_closed_at: string | null
          issue_number: number
          labels: string[]
          output_tokens: number | null
          pr_merged_at: string | null
          pr_number: number | null
          repo: string
          repo_id: number
          task_id: string
          title: string
          worker_id: string | null
        }
        Insert: {
          assigned_at?: string | null
          body?: string
          branch?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          input_tokens?: number | null
          issue_closed_at?: string | null
          issue_number: number
          labels?: string[]
          output_tokens?: number | null
          pr_merged_at?: string | null
          pr_number?: number | null
          repo: string
          repo_id: number
          task_id: string
          title: string
          worker_id?: string | null
        }
        Update: {
          assigned_at?: string | null
          body?: string
          branch?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          input_tokens?: number | null
          issue_closed_at?: string | null
          issue_number?: number
          labels?: string[]
          output_tokens?: number | null
          pr_merged_at?: string | null
          pr_number?: number | null
          repo?: string
          repo_id?: number
          task_id?: string
          title?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          action: string | null
          branch: string | null
          delivery_id: string | null
          event_name: string
          id: number
          issue_number: number | null
          payload: Json
          pr_number: number | null
          received_at: string
          repo_id: number | null
          sender: string | null
          task_id: string | null
          worker_id: string | null
        }
        Insert: {
          action?: string | null
          branch?: string | null
          delivery_id?: string | null
          event_name: string
          id?: never
          issue_number?: number | null
          payload: Json
          pr_number?: number | null
          received_at?: string
          repo_id?: number | null
          sender?: string | null
          task_id?: string | null
          worker_id?: string | null
        }
        Update: {
          action?: string | null
          branch?: string | null
          delivery_id?: string | null
          event_name?: string
          id?: never
          issue_number?: number | null
          payload?: Json
          pr_number?: number | null
          received_at?: string
          repo_id?: number | null
          sender?: string | null
          task_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      workers: {
        Row: {
          current_task_id: string | null
          disconnected_at: string | null
          first_connected_at: string
          goodbye_at: string | null
          last_connected_at: string
          num_connections: number
          protocol_version: number | null
          repo_id: number
          status: string
          version: string | null
          worker_id: string
        }
        Insert: {
          current_task_id?: string | null
          disconnected_at?: string | null
          first_connected_at?: string
          goodbye_at?: string | null
          last_connected_at?: string
          num_connections?: number
          protocol_version?: number | null
          repo_id: number
          status?: string
          version?: string | null
          worker_id: string
        }
        Update: {
          current_task_id?: string | null
          disconnected_at?: string | null
          first_connected_at?: string
          goodbye_at?: string | null
          last_connected_at?: string
          num_connections?: number
          protocol_version?: number | null
          repo_id?: number
          status?: string
          version?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workers_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

