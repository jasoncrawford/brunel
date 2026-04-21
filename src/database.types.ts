// Generated from Supabase schema via: supabase gen types typescript --local > src/database.types.ts
// Regenerate after any migration.

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
      repos: {
        Row: {
          id: number
          full_name: string
          status: string
          created_at: string
        }
        Insert: {
          id?: never
          full_name: string
          status?: string
          created_at?: string
        }
        Update: {
          id?: never
          full_name?: string
          status?: string
          created_at?: string
        }
        Relationships: []
      }
      foreman_messages: {
        Row: {
          id: number
          created_at: string
          direction: string
          worker_id: string | null
          task_id: string | null
          msg_type: string
          payload: Json
        }
        Insert: {
          id?: never
          created_at?: string
          direction: string
          worker_id?: string | null
          task_id?: string | null
          msg_type: string
          payload: Json
        }
        Update: {
          id?: never
          created_at?: string
          direction?: string
          worker_id?: string | null
          task_id?: string | null
          msg_type?: string
          payload?: Json
        }
        Relationships: []
      }
      tasks: {
        Row: {
          task_id: string
          issue_number: number
          repo: string
          repo_id: number
          title: string
          body: string
          labels: string[]
          worker_id: string | null
          pr_number: number | null
          branch: string | null
          created_at: string
          assigned_at: string | null
          completed_at: string | null
          issue_closed_at: string | null
          pr_merged_at: string | null
        }
        Insert: {
          task_id: string
          issue_number: number
          repo: string
          repo_id: number
          title: string
          body?: string
          labels?: string[]
          worker_id?: string | null
          pr_number?: number | null
          branch?: string | null
          created_at?: string
          assigned_at?: string | null
          completed_at?: string | null
          issue_closed_at?: string | null
          pr_merged_at?: string | null
        }
        Update: {
          task_id?: string
          issue_number?: number
          repo?: string
          repo_id?: number
          title?: string
          body?: string
          labels?: string[]
          worker_id?: string | null
          pr_number?: number | null
          branch?: string | null
          created_at?: string
          assigned_at?: string | null
          completed_at?: string | null
          issue_closed_at?: string | null
          pr_merged_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          }
        ]
      }
      webhook_events: {
        Row: {
          id: number
          received_at: string
          delivery_id: string | null
          event_name: string
          action: string | null
          repo_id: number | null
          sender: string | null
          issue_number: number | null
          pr_number: number | null
          branch: string | null
          task_id: string | null
          payload: Json
          worker_id: string | null
        }
        Insert: {
          id?: never
          received_at?: string
          delivery_id?: string | null
          event_name: string
          action?: string | null
          repo_id?: number | null
          sender?: string | null
          issue_number?: number | null
          pr_number?: number | null
          branch?: string | null
          task_id?: string | null
          payload: Json
          worker_id?: string | null
        }
        Update: {
          id?: never
          received_at?: string
          delivery_id?: string | null
          event_name?: string
          action?: string | null
          repo_id?: number | null
          sender?: string | null
          issue_number?: number | null
          pr_number?: number | null
          branch?: string | null
          task_id?: string | null
          payload?: Json
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          }
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

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never
